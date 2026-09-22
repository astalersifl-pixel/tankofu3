const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ルートディレクトリの index.html を直接配信
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let gameState = {
  players: [], // { id, name, scoreCards: [], eventCards: [] }
  currentTurnIndex: 0,
  isGameStarted: false,
  decks: { actionDeck: [], mineDeck: [], eventDeck: [] },
  discardActionDeck: [], // 使用済み行動カード
  logs: []
};

function initializeDecks() {
  // 鉱山: 21枚 (石炭1点x10, 金2点x7, ダイヤ3点x3, 爆弾x1)
  let mine = [];
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', name: '石炭', value: 1 });
  for (let i = 0; i < 7; i++) mine.push({ type: 'score', name: '金', value: 2 });
  for (let i = 0; i < 3; i++) mine.push({ type: 'score', name: 'ダイヤ', value: 3 });
  mine.push({ type: 'bomb', name: '爆弾', value: 0 });

  // 行動: 20枚 (つるはしx10, ドリルx5, イベントx5)
  let action = [];
  for (let i = 0; i < 10; i++) action.push('つるはし');
  for (let i = 0; i < 5; i++) action.push('ドリル');
  for (let i = 0; i < 5; i++) action.push('イベント');

  // イベント: 12枚
  let eventList = [
    { id: 'survey', name: '調査' }, { id: 'survey', name: '調査' },
    { id: 'bribe', name: '賄賂' },
    { id: 'mine', name: '採掘' }, { id: 'mine', name: '採掘' },
    { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' },
    { id: 'share', name: '山分け' },
    { id: 'reveal', name: '公開' }, { id: 'reveal', name: '公開' },
    { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' }
  ];

  return {
    mineDeck: shuffle(mine),
    actionDeck: shuffle(action),
    eventDeck: shuffle(eventList)
  };
}

function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function broadcastState(extra = {}) {
  gameState.players.forEach((p, idx) => {
    const isCurrent = (idx === gameState.currentTurnIndex && gameState.isGameStarted);
    const opponents = gameState.players.map((other, oIdx) => ({
      id: other.id,
      name: other.name,
      scoreCardCount: other.scoreCards.length,
      eventCardCount: other.eventCards.length,
      isCurrentTurn: (oIdx === gameState.currentTurnIndex && gameState.isGameStarted)
    }));

    io.to(p.id).emit('state_update', {
      isGameStarted: gameState.isGameStarted,
      isMyTurn: isCurrent,
      myHand: {
        scoreCards: p.scoreCards,
        eventCards: p.eventCards
      },
      opponents,
      deckCounts: {
        mine: gameState.decks.mineDeck.length,
        action: gameState.decks.actionDeck.length,
        event: gameState.decks.eventDeck.length
      },
      logs: gameState.logs.slice(-5),
      allPlayerNames: gameState.players.map(pl => pl.name),
      extraData: extra
    });
  });
}

function broadcastLobby() {
  io.emit('lobby_status', {
    players: gameState.players.map(p => p.name),
    isGameStarted: gameState.isGameStarted
  });
}

function drawFromMine(player, count) {
  let drawn = [];
  for (let i = 0; i < count; i++) {
    if (gameState.decks.mineDeck.length > 0) {
      drawn.push(gameState.decks.mineDeck.pop());
    }
  }
  player.scoreCards.push(...drawn);
  const cardNames = drawn.map(c => c.name || (c.type === 'bomb' ? '爆弾' : `${c.value}点`)).join(', ');
  gameState.logs.push(`${player.name} は鉱山から【${drawn.length}枚】採掘しました`);
}

function nextTurn() {
  gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
  broadcastState();
}

function endGame() {
  gameState.logs.push('鉱山が空になりました！ ゲーム終了です！');

  let results = gameState.players.map(p => {
    let hasBomb = p.scoreCards.some(c => c.type === 'bomb');
    let validScores = p.scoreCards.filter(c => c.type === 'score');

    // 爆弾所持の場合、ランダムで1枚得点カード破壊
    if (hasBomb && validScores.length > 0) {
      const destroyedIdx = Math.floor(Math.random() * validScores.length);
      validScores.splice(destroyedIdx, 1);
    }

    const total = validScores.reduce((sum, c) => sum + (c.value || 0), 0);
    return {
      name: p.name,
      score: total,
      hasBomb: hasBomb
    };
  });

  results.sort((a, b) => b.score - a.score);
  const maxScore = results[0] ? results[0].score : 0;
  const winners = results.filter(r => r.score === maxScore).map(r => r.name);

  broadcastState({
    gameOver: true,
    results: results,
    winners: winners,
    maxScore: maxScore
  });
}

io.on('connection', (socket) => {
  // 初期ロビー情報を送信
  socket.emit('lobby_status', {
    players: gameState.players.map(p => p.name),
    isGameStarted: gameState.isGameStarted
  });

  // プレイヤー参加
  socket.on('join_game', (playerName) => {
    if (gameState.isGameStarted) {
      socket.emit('error_message', 'すでにゲームが開始されています');
      return;
    }
    if (gameState.players.length >= 5) {
      socket.emit('error_message', '定員（5名）に達しています');
      return;
    }

    const player = {
      id: socket.id,
      name: playerName || `採掘者${gameState.players.length + 1}`,
      scoreCards: [],
      eventCards: []
    };
    gameState.players.push(player);
    gameState.logs.push(`${player.name} が入室しました`);

    broadcastLobby();
    broadcastState();
  });

  // ゲーム開始
  socket.on('start_game', () => {
    if (gameState.players.length < 1) return;
    if (gameState.isGameStarted) return;

    gameState.isGameStarted = true;
    gameState.decks = initializeDecks();
    gameState.discardActionDeck = [];
    gameState.currentTurnIndex = 0;
    gameState.logs.push('ゲームが開始されました！');

    broadcastState();
  });

  // 再戦・ロビーへ戻る
  socket.on('restart_game', () => {
    gameState.isGameStarted = false;
    gameState.currentTurnIndex = 0;
    gameState.decks = { actionDeck: [], mineDeck: [], eventDeck: [] };
    gameState.discardActionDeck = [];
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームがリセットされました。再戦待機中です。');
    broadcastState({ gameOver: false });
  });

  // 行動山札を引く
  socket.on('draw_action_deck', () => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    if (gameState.decks.actionDeck.length === 0) {
      gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
      gameState.discardActionDeck = [];
      gameState.logs.push('行動山札をリシャッフルしました');
    }

    const drawn = gameState.decks.actionDeck.pop();
    gameState.discardActionDeck.push(drawn);
    gameState.logs.push(`${currentPlayer.name} は行動【${drawn}】を引きました`);

    if (drawn === 'つるはし') {
      drawFromMine(currentPlayer, 1);
    } else if (drawn === 'ドリル') {
      drawFromMine(currentPlayer, 2);
    } else if (drawn === 'イベント') {
      if (gameState.decks.eventDeck.length > 0) {
        currentPlayer.eventCards.push(gameState.decks.eventDeck.pop());
      } else {
        // イベント山札が無い場合、行動山札からもう1枚
        if (gameState.decks.actionDeck.length === 0) {
          gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
          gameState.discardActionDeck = [];
        }
        if (gameState.decks.actionDeck.length > 0) {
          const extra = gameState.decks.actionDeck.pop();
          gameState.discardActionDeck.push(extra);
          gameState.logs.push(`イベント無いため追加で行動【${extra}】を引きました`);
          if (extra === 'つるはし') drawFromMine(currentPlayer, 1);
          if (extra === 'ドリル') drawFromMine(currentPlayer, 2);
        }
      }
    }

    // 鉱山切れチェック
    if (gameState.decks.mineDeck.length === 0) {
      endGame();
      return;
    }

    nextTurn();
  });

  // イベントカード使用
  socket.on('use_event', (cardIndex) => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (!currentPlayer.eventCards[cardIndex]) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました`);

    // 使用後はイベント山札の一番下に戻す
    gameState.decks.eventDeck.unshift(usedCard);

    // イベント効果分岐
    if (usedCard.id === 'survey') {
      // 調査：鉱山の中身（上から順）を見る
      const mineContent = gameState.decks.mineDeck.map(c => 
        c.type === 'bomb' ? '💥爆弾' : `${c.name} (${c.value}点)`
      );
      socket.emit('show_mine_cards', mineContent);
    } else if (usedCard.id === 'mine') {
      // 採掘：鉱山から1枚引く
      drawFromMine(currentPlayer, 1);
      if (gameState.decks.mineDeck.length === 0) { endGame(); return; }
    } else if (usedCard.id === 'share') {
      // 山分け：全プレイヤーが得点を持っていれば実行
      const allHave = gameState.players.every(p => p.scoreCards.length > 0);
      if (allHave) {
        let allScores = [];
        gameState.players.forEach(p => {
          allScores.push(...p.scoreCards);
          p.scoreCards = [];
        });
        allScores = shuffle(allScores);

        // 使用者の左隣（次の人）から順に時計回り配り、自分が最後になるように配る
        let pIdx = (gameState.currentTurnIndex + 1) % gameState.players.length;
        while (allScores.length > 0) {
          gameState.players[pIdx].scoreCards.push(allScores.pop());
          pIdx = (pIdx + 1) % gameState.players.length;
        }
        gameState.logs.push('得点カードの山分けが行われました！');
      } else {
        gameState.logs.push('全員が得点を持っていないため山分け失敗');
      }
    } else if (usedCard.id === 'reveal') {
      // 公開：ランダム1人の得点を開示
      const target = gameState.players[Math.floor(Math.random() * gameState.players.length)];
      const cardsStr = target.scoreCards.map(c => 
        c.type === 'bomb' ? '💥爆弾' : `${c.name}(${c.value}点)`
      ).join(', ');
      gameState.logs.push(`【公開】${target.name} の得点: [${cardsStr}]`);
    } else if (usedCard.id === 'rob') {
      // 強奪：一番多く得点を持っている他プレイヤーからランダム1枚奪う
      let maxCount = -1;
      let targets = [];
      gameState.players.forEach(p => {
        if (p.id !== currentPlayer.id) {
          if (p.scoreCards.length > maxCount) {
            maxCount = p.scoreCards.length;
            targets = [p];
          } else if (p.scoreCards.length === maxCount) {
            targets.push(p);
          }
        }
      });

      if (targets.length > 0 && maxCount > 0) {
        const victim = targets[Math.floor(Math.random() * targets.length)];
        const robIdx = Math.floor(Math.random() * victim.scoreCards.length);
        const stolen = victim.scoreCards.splice(robIdx, 1)[0];
        currentPlayer.scoreCards.push(stolen);
        gameState.logs.push(`${currentPlayer.name} は ${victim.name} からカードを強奪しました！`);
      } else {
        gameState.logs.push('強奪できる相手がいませんでした');
      }
    } else if (usedCard.id === 'bribe') {
      // 賄賂：鉱山からボーナスで1枚引く
      drawFromMine(currentPlayer, 1);
      if (gameState.decks.mineDeck.length === 0) { endGame(); return; }
    } else if (usedCard.id === 'trade') {
      // 取引：他プレイヤー1人と得点を1枚交換
      const otherPlayers = gameState.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
      if (otherPlayers.length > 0 && currentPlayer.scoreCards.length > 0) {
        const target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
        const myIdx = Math.floor(Math.random() * currentPlayer.scoreCards.length);
        const targetIdx = Math.floor(Math.random() * target.scoreCards.length);

        const myCard = currentPlayer.scoreCards.splice(myIdx, 1)[0];
        const targetCard = target.scoreCards.splice(targetIdx, 1)[0];

        currentPlayer.scoreCards.push(targetCard);
        target.scoreCards.push(myCard);
        gameState.logs.push(`${currentPlayer.name} と ${target.name} でカードの取引が行われました`);
      } else {
        gameState.logs.push('取引の条件を満たせませんでした');
      }
    }

    broadcastState();
  });

  // 切断処理
  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length === 0) {
      gameState.isGameStarted = false;
      gameState.decks = { actionDeck: [], mineDeck: [], eventDeck: [] };
      gameState.discardActionDeck = [];
      gameState.currentTurnIndex = 0;
      gameState.logs = [];
    } else {
      if (gameState.currentTurnIndex >= gameState.players.length) {
        gameState.currentTurnIndex = 0;
      }
    }
    broadcastLobby();
    broadcastState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`炭鉱夫サーバー起動完了: http://0.0.0.0:${PORT}`);
});
