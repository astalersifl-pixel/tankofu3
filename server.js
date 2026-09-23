import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ゲーム全体の状態管理
let gameState = {
  isGameStarted: false,
  players: [], // { id, name, scoreCards: [], eventCards: [] }
  currentTurnIndex: 0,
  decks: {
    mineDeck: [],
    actionDeck: [],
    eventDeck: []
  },
  discardActionDeck: [],
  logs: []
};

function initializeDecks() {
  // 鉱山: 21枚 (石炭1点x10, 金2点x7, ダイヤ3点x3, 爆弾x1)
  let mine = [];
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', name: '石炭', value: 1 });
  for (let i = 0; i < 7; i++) mine.push({ type: 'score', name: '金', value: 2 });
  for (let i = 0; i < 3; i++) mine.push({ type: 'score', name: 'ダイヤ', value: 3 });
  mine.push({ type: 'bomb', name: '爆弾', value: 0 });

  // 行動: 20枚 (つるはし:ドリル = 7:3 -> つるはしx14, ドリルx6)
  let action = [];
  for (let i = 0; i < 14; i++) action.push('つるはし');
  for (let i = 0; i < 6; i++) action.push('ドリル');

  // イベント: 12枚
  let eventList = [
    { id: 'survey', name: '調査' }, { id: 'survey', name: '調査' },
    { id: 'bribe', name: '賄賂' },
    { id: 'blast', name: '爆破' }, { id: 'blast', name: '爆破' },
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

// クライアントへ状態を一斉送信
function broadcastState(extraData = null) {
  gameState.players.forEach(p => {
    const myTurn = gameState.isGameStarted && gameState.players[gameState.currentTurnIndex]?.id === p.id;
    const clientState = {
      isGameStarted: gameState.isGameStarted,
      isMyTurn: myTurn,
      currentTurnPlayerName: gameState.players[gameState.currentTurnIndex]?.name || '',
      allPlayerNames: gameState.players.map(pl => pl.name),
      myHand: {
        scoreCards: p.scoreCards,
        eventCards: p.eventCards
      },
      opponents: gameState.players.filter(pl => pl.id !== p.id).map(opp => ({
        name: opp.name,
        scoreCardCount: opp.scoreCards.length,
        eventCardCount: opp.eventCards.length,
        isCurrentTurn: gameState.players[gameState.currentTurnIndex]?.id === opp.id
      })),
      deckCounts: {
        mine: gameState.decks.mineDeck.length,
        action: gameState.decks.actionDeck.length,
        event: gameState.decks.eventDeck.length
      },
      logs: gameState.logs.slice(-5),
      extraData: extraData
    };
    io.to(p.id).emit('state_update', clientState);
  });
}

function nextTurn() {
  if (gameState.players.length === 0) return;
  gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
  broadcastState();
}

function drawFromMine(player, count) {
  for (let i = 0; i < count; i++) {
    if (gameState.decks.mineDeck.length > 0) {
      const card = gameState.decks.mineDeck.pop();
      player.scoreCards.push(card);
      gameState.logs.push(`${player.name} は鉱山からカードを1枚採掘しました`);
    } else {
      break;
    }
  }
}

function endGame() {
  gameState.logs.push('【鉱山枯渇】ゲームが終了しました！');

  // 爆弾処理（爆弾を持っている人の得点カードを1枚破壊）
  gameState.players.forEach(p => {
    const hasBomb = p.scoreCards.some(c => c.type === 'bomb');
    if (hasBomb) {
      const nonBombIndices = [];
      p.scoreCards.forEach((c, idx) => {
        if (c.type !== 'bomb') nonBombIndices.push(idx);
      });
      if (nonBombIndices.length > 0) {
        const destroyIdx = nonBombIndices[Math.floor(Math.random() * nonBombIndices.length)];
        const destroyed = p.scoreCards.splice(destroyIdx, 1)[0];
        gameState.logs.push(`💣 爆弾爆発！ ${p.name} の【${destroyed.name}(${destroyed.value}点)】が破壊されました！`);
      } else {
        gameState.logs.push(`💣 爆弾爆発！ しかし ${p.name} に破壊できる得点カードがありませんでした`);
      }
    }
  });

  // 得点計算
  const results = gameState.players.map(p => {
    const score = p.scoreCards.reduce((sum, c) => sum + (c.value || 0), 0);
    const hasBomb = p.scoreCards.some(c => c.type === 'bomb');
    return { name: p.name, score, hasBomb };
  });

  results.sort((a, b) => b.score - a.score);
  const maxScore = results[0]?.score ?? 0;
  const winners = results.filter(r => r.score === maxScore).map(r => r.name);

  broadcastState({
    gameOver: true,
    results: results,
    winners: winners,
    maxScore: maxScore
  });
}

io.on('connection', (socket) => {
  socket.emit('lobby_status', {
    players: gameState.players.map(p => p.name)
  });

  // 参加
  socket.on('join_game', (playerName) => {
    if (gameState.isGameStarted) {
      socket.emit('error_message', 'ゲームは既に開始されています。終了をお待ちください。');
      return;
    }
    if (gameState.players.length >= 5) {
      socket.emit('error_message', '満員です（最大5人）');
      return;
    }
    const cleanName = (playerName || `プレイヤー${gameState.players.length + 1}`).trim().substring(0, 10);
    const newPlayer = {
      id: socket.id,
      name: cleanName,
      scoreCards: [],
      eventCards: []
    };
    gameState.players.push(newPlayer);
    gameState.logs.push(`${cleanName} が入室しました`);
    broadcastState();
  });

  // ゲーム開始
  socket.on('start_game', () => {
    if (gameState.players.length < 1) {
      socket.emit('error_message', 'プレイヤーが足りません');
      return;
    }
    gameState.decks = initializeDecks();
    gameState.discardActionDeck = [];
    gameState.isGameStarted = true;
    gameState.currentTurnIndex = 0;
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームを開始しました！');
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
      if (gameState.decks.eventDeck.length > 0) {
        const evCard = gameState.decks.eventDeck.pop();
        currentPlayer.eventCards.push(evCard);
        gameState.logs.push(`${currentPlayer.name} はイベントカード【${evCard.name}】を引きました`);
      } else {
        gameState.logs.push('イベント山札が空のため引けませんでした');
      }
    } else if (drawn === 'ドリル') {
      drawFromMine(currentPlayer, 2);
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
    if (cardIndex < 0 || cardIndex >= currentPlayer.eventCards.length) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.decks.eventDeck.unshift(usedCard); // 使用したイベントカードは山札の底に戻す
    gameState.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました！`);

    // イベント効果分岐
    switch (usedCard.id) {
      case 'survey': {
        // 調査: 鉱山山札の順序を自分だけ見る
        const cardsNames = [...gameState.decks.mineDeck].reverse().map(c => c.name);
        socket.emit('show_mine_cards', cardsNames);
        break;
      }
      case 'blast': {
        // 爆破: 爆弾カードを持つプレイヤーは爆弾とランダムに選ばれた得点カード1枚を鉱山に戻しシャッフル。誰も持っていなければ不発
        let blastTriggered = false;
        gameState.players.forEach(p => {
          const bombIndex = p.scoreCards.findIndex(c => c.type === 'bomb');
          if (bombIndex !== -1) {
            blastTriggered = true;
            const bombCard = p.scoreCards.splice(bombIndex, 1)[0];
            gameState.decks.mineDeck.push(bombCard);

            if (p.scoreCards.length > 0) {
              const randScoreIdx = Math.floor(Math.random() * p.scoreCards.length);
              const returnedCard = p.scoreCards.splice(randScoreIdx, 1)[0];
              gameState.decks.mineDeck.push(returnedCard);
              gameState.logs.push(`💣 【爆破】発動！ ${p.name} は爆弾と【${returnedCard.name}】を鉱山に戻しました`);
            } else {
              gameState.logs.push(`💣 【爆破】発動！ ${p.name} は爆弾を鉱山に戻しました（得点カード無し）`);
            }
          }
        });

        if (blastTriggered) {
          gameState.decks.mineDeck = shuffle(gameState.decks.mineDeck);
          gameState.logs.push('鉱山山札がシャッフルされました');
        } else {
          gameState.logs.push('💣 【爆破】不発：誰も爆弾を持っていませんでした');
        }
        break;
      }
      case 'trade': {
        // 取引: ランダムに相手1人と得点カード1枚をランダム交換
        const others = gameState.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
        if (others.length > 0 && currentPlayer.scoreCards.length > 0) {
          const target = others[Math.floor(Math.random() * others.length)];
          const myCardIdx = Math.floor(Math.random() * currentPlayer.scoreCards.length);
          const targetCardIdx = Math.floor(Math.random() * target.scoreCards.length);

          const myCard = currentPlayer.scoreCards.splice(myCardIdx, 1)[0];
          const targetCard = target.scoreCards.splice(targetCardIdx, 1)[0];

          currentPlayer.scoreCards.push(targetCard);
          target.scoreCards.push(myCard);

          gameState.logs.push(`${currentPlayer.name} と ${target.name} は得点カードを1枚交換しました`);
        } else {
          gameState.logs.push('交換できるカードを持つ相手がいないため、取引は不発でした');
        }
        break;
      }
      case 'share': {
        // 山分け: 全員の得点カードを回収し、時計回りに再分配
        let pool = [];
        gameState.players.forEach(p => {
          pool.push(...p.scoreCards);
          p.scoreCards = [];
        });
        pool = shuffle(pool);
        let pIndex = gameState.currentTurnIndex;
        while (pool.length > 0) {
          gameState.players[pIndex].scoreCards.push(pool.pop());
          pIndex = (pIndex + 1) % gameState.players.length;
        }
        gameState.logs.push('🤝 全員の得点カードが山分けされ、再分配されました！');
        break;
      }
      case 'bribe': {
        // 賄賂: 自分の得点のカードの一番小さい得点のカードを鉱山に戻し、イベント山札から2枚引く
        const scoreOnlyCards = currentPlayer.scoreCards.filter(c => c.type === 'score');
        if (scoreOnlyCards.length > 0) {
          let minVal = Math.min(...scoreOnlyCards.map(c => c.value));
          let minCardIdx = currentPlayer.scoreCards.findIndex(c => c.type === 'score' && c.value === minVal);
          const returnedCard = currentPlayer.scoreCards.splice(minCardIdx, 1)[0];
          gameState.decks.mineDeck.push(returnedCard);
          gameState.decks.mineDeck = shuffle(gameState.decks.mineDeck);

          let drawnCount = 0;
          for (let i = 0; i < 2; i++) {
            if (gameState.decks.eventDeck.length > 0) {
              const ev = gameState.decks.eventDeck.pop();
              currentPlayer.eventCards.push(ev);
              drawnCount++;
            }
          }
          gameState.logs.push(`💰 ${currentPlayer.name} は賄賂を使い、【${returnedCard.name}(${returnedCard.value}点)】を鉱山に戻してイベントカードを${drawnCount}枚獲得しました`);
        } else {
          gameState.logs.push(`💰 ${currentPlayer.name} には戻せる得点カードがありませんでした（賄賂不発）`);
        }
        break;
      }
      case 'reveal': {
        // 公開: ランダムなプレイヤー1人の手札得点を全員に公開
        const cand = gameState.players.filter(p => p.scoreCards.length > 0);
        if (cand.length > 0) {
          const target = cand[Math.floor(Math.random() * cand.length)];
          const names = target.scoreCards.map(c => c.name).join(', ');
          gameState.logs.push(`👁️ 【手札公開】 ${target.name} の得点カード: [ ${names} ]`);
        } else {
          gameState.logs.push('得点カードを持つプレイヤーがいませんでした');
        }
        break;
      }
      case 'rob': {
        // 強奪: 最も得点カードを多く持つ相手から1枚奪う
        const others = gameState.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
        if (others.length > 0) {
          let maxCount = -1;
          others.forEach(p => {
            if (p.scoreCards.length > maxCount) maxCount = p.scoreCards.length;
          });
          const targets = others.filter(p => p.scoreCards.length === maxCount);
          const victim = targets[Math.floor(Math.random() * targets.length)];

          const randIdx = Math.floor(Math.random() * victim.scoreCards.length);
          const stolen = victim.scoreCards.splice(randIdx, 1)[0];
          currentPlayer.scoreCards.push(stolen);

          gameState.logs.push(`🦹 ${currentPlayer.name} は ${victim.name} からカードを1枚奪いました！`);
        } else {
          gameState.logs.push('奪えるカードを持つ相手がいませんでした');
        }
        break;
      }
      default:
        break;
    }

    nextTurn();
  });

  // 切断処理
  socket.on('disconnect', () => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const removed = gameState.players.splice(idx, 1)[0];
      gameState.logs.push(`${removed.name} が退出しました`);

      if (gameState.players.length === 0) {
        gameState.isGameStarted = false;
        gameState.currentTurnIndex = 0;
        gameState.decks = { mineDeck: [], actionDeck: [], eventDeck: [] };
        gameState.discardActionDeck = [];
      } else if (gameState.currentTurnIndex >= gameState.players.length) {
        gameState.currentTurnIndex = 0;
      }
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`炭鉱夫サーバーが起動しました: http://localhost:${PORT}`);
});
