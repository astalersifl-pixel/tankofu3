import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let gameState = {
  players: [],
  currentTurnIndex: 0,
  isGameStarted: false,
  decks: { actionDeck: [], mineDeck: [], eventDeck: [] },
  discardActionDeck: [],
  logs: []
};

function initializeDecks() {
  let mine = [];
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', value: 1 });
  for (let i = 0; i < 7; i++) mine.push({ type: 'score', value: 2 });
  for (let i = 0; i < 3; i++) mine.push({ type: 'score', value: 3 });
  mine.push({ type: 'bomb', value: '爆弾' });

  let action = [];
  for (let i = 0; i < 10; i++) action.push('1');
  for (let i = 0; i < 5; i++) action.push('2');
  for (let i = 0; i < 5; i++) action.push('イベ');

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

function broadcastState(extraData = null) {
  const currentTurnPlayer = gameState.players[gameState.currentTurnIndex];

  gameState.players.forEach(p => {
    const sanitizedPlayers = gameState.players.map(other => ({
      id: other.id,
      name: other.name,
      scoreCardCount: other.scoreCards.length,
      eventCardCount: other.eventCards.length,
      isCurrentTurn: currentTurnPlayer && currentTurnPlayer.id === other.id
    }));

    const clientState = {
      isGameStarted: gameState.isGameStarted,
      playerCount: gameState.players.length,
      allPlayerNames: gameState.players.map(pl => pl.name),
      myHand: { scoreCards: p.scoreCards, eventCards: p.eventCards },
      opponents: sanitizedPlayers,
      deckCounts: {
        mine: gameState.decks.mineDeck ? gameState.decks.mineDeck.length : 0,
        action: gameState.decks.actionDeck ? gameState.decks.actionDeck.length : 0,
        event: gameState.decks.eventDeck ? gameState.decks.eventDeck.length : 0
      },
      isMyTurn: currentTurnPlayer && currentTurnPlayer.id === p.id,
      logs: gameState.logs.slice(-6),
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
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (gameState.decks.mineDeck.length > 0) {
      player.scoreCards.push(gameState.decks.mineDeck.pop());
      drawn++;
    }
  }
  return drawn;
}

io.on('connection', (socket) => {
  socket.emit('lobby_status', {
    playerCount: gameState.players.length,
    players: gameState.players.map(p => p.name),
    isGameStarted: gameState.isGameStarted
  });

  socket.on('join_game', (playerName) => {
    if (gameState.isGameStarted) return socket.emit('error_message', 'ゲーム中のため参加できません');
    if (gameState.players.length >= 5) return socket.emit('error_message', '満員です（最大5名）');

    const cleanName = (playerName || '').trim() || `プレイヤー${gameState.players.length + 1}`;
    const newPlayer = {
      id: socket.id,
      name: cleanName,
      scoreCards: [],
      eventCards: []
    };
    gameState.players.push(newPlayer);
    gameState.logs.push(`${newPlayer.name} が入室しました（計${gameState.players.length}名）`);
    broadcastState();
  });

  socket.on('start_game', () => {
    if (gameState.players.length < 1) {
      return socket.emit('error_message', 'プレイヤーが足りません');
    }
    gameState.decks = initializeDecks();
    gameState.discardActionDeck = [];
    gameState.isGameStarted = true;
    gameState.currentTurnIndex = 0;
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームを開始しました！');
    broadcastState();
  });

  socket.on('restart_game', () => {
    gameState.isGameStarted = false;
    gameState.currentTurnIndex = 0;
    gameState.decks = { actionDeck: [], mineDeck: [], eventDeck: [] };
    gameState.discardActionDeck = [];
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームがリセットされました。再戦待機中です。');
    broadcastState({ gameOver: false });
  });

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

    if (drawn === '1') {
      drawFromMine(currentPlayer, 1);
    } else if (drawn === '2') {
      drawFromMine(currentPlayer, 2);
    } else if (drawn === 'イベ') {
      if (gameState.decks.eventDeck.length > 0) {
        currentPlayer.eventCards.push(gameState.decks.eventDeck.pop());
      } else {
        if (gameState.decks.actionDeck.length === 0) {
          gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
          gameState.discardActionDeck = [];
        }
        if (gameState.decks.actionDeck.length > 0) {
          const extra = gameState.decks.actionDeck.pop();
          gameState.discardActionDeck.push(extra);
          gameState.logs.push(`イベント無いため追加で行動【${extra}】を引きました`);
          if (extra === '1') drawFromMine(currentPlayer, 1);
          if (extra === '2') drawFromMine(currentPlayer, 2);
        }
      }
    }

    if (gameState.decks.mineDeck.length === 0) {
      endGame();
      return;
    }

    nextTurn();
  });

  socket.on('use_event', (cardIndex) => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (!currentPlayer.eventCards[cardIndex]) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました`);
    gameState.decks.eventDeck.unshift(usedCard);

    if (usedCard.id === 'survey') {
      const mineContent = gameState.decks.mineDeck.map(c => c.value);
      socket.emit('show_mine_cards', mineContent);
    } else if (usedCard.id === 'mine') {
      drawFromMine(currentPlayer, 1);
      if (gameState.decks.mineDeck.length === 0) { endGame(); return; }
    } else if (usedCard.id === 'share') {
      const allHave = gameState.players.every(p => p.scoreCards.length > 0);
      if (allHave) {
        let allScores = [];
        gameState.players.forEach(p => {
          allScores.push(...p.scoreCards);
          p.scoreCards = [];
        });
        allScores = shuffle(allScores);

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
      const target = gameState.players[Math.floor(Math.random() * gameState.players.length)];
      const cardsStr = target.scoreCards.map(c => c.value).join(', ');
      gameState.logs.push(`【公開】${target.name} の得点: [${cardsStr}]`);
    } else if (usedCard.id === 'rob') {
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
        const target = targets[Math.floor(Math.random() * targets.length)];
        const robIdx = Math.floor(Math.random() * target.scoreCards.length);
        const robbed = target.scoreCards.splice(robIdx, 1)[0];
        currentPlayer.scoreCards.push(robbed);
        gameState.logs.push(`${currentPlayer.name} は ${target.name} から得点を1枚奪いました`);
      } else {
        gameState.logs.push('他プレイヤーに奪える得点がありませんでした');
      }
    } else if (usedCard.id === 'trade') {
      const otherPlayersWithCards = gameState.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
      if (currentPlayer.scoreCards.length > 0 && otherPlayersWithCards.length > 0) {
        const partner = otherPlayersWithCards[Math.floor(Math.random() * otherPlayersWithCards.length)];
        const myCardIdx = Math.floor(Math.random() * currentPlayer.scoreCards.length);
        const partnerCardIdx = Math.floor(Math.random() * partner.scoreCards.length);

        const myCard = currentPlayer.scoreCards.splice(myCardIdx, 1)[0];
        const partnerCard = partner.scoreCards.splice(partnerCardIdx, 1)[0];

        currentPlayer.scoreCards.push(partnerCard);
        partner.scoreCards.push(myCard);

        gameState.logs.push(`${currentPlayer.name} は ${partner.name} と得点カードを取引しました`);
      } else {
        gameState.logs.push('カードが不足しているため取引は不発でした');
      }
    } else if (usedCard.id === 'bribe') {
      gameState.logs.push(`${currentPlayer.name} は賄賂を使い、鉱山から追加で1枚採掘しました！`);
      drawFromMine(currentPlayer, 1);
      if (gameState.decks.mineDeck.length === 0) { endGame(); return; }
    }

    nextTurn();
  });

  socket.on('disconnect', () => {
    const leftPlayer = gameState.players.find(p => p.id === socket.id);
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (leftPlayer) {
      gameState.logs.push(`${leftPlayer.name} が退出しました`);
    }
    if (gameState.players.length === 0) {
      gameState.isGameStarted = false;
    } else if (gameState.currentTurnIndex >= gameState.players.length) {
      gameState.currentTurnIndex = 0;
    }
    broadcastState();
  });
});

function endGame() {
  gameState.logs.push('===================');
  gameState.logs.push('鉱山がなくなりました！ゲーム終了！');

  let results = gameState.players.map(p => {
    let hasBomb = p.scoreCards.some(c => c.type === 'bomb');
    let cards = [...p.scoreCards];

    if (hasBomb) {
      let nonBombIndices = [];
      cards.forEach((c, idx) => { if (c.type !== 'bomb') nonBombIndices.push(idx); });
      if (nonBombIndices.length > 0) {
        let discardIdx = nonBombIndices[Math.floor(Math.random() * nonBombIndices.length)];
        cards.splice(discardIdx, 1);
      }
    }

    let score = cards.reduce((sum, c) => sum + (typeof c.value === 'number' ? c.value : 0), 0);
    return { name: p.name, score: score, hasBomb: hasBomb, originalCount: p.scoreCards.length };
  });

  let maxScore = Math.max(...results.map(r => r.score), 0);
  let winners = results.filter(r => r.score === maxScore).map(r => r.name);

  gameState.logs.push(`勝者: ${winners.join(', ')} (得点: ${maxScore}点)`);
  broadcastState({ gameOver: true, results: results, winners: winners, maxScore: maxScore });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`炭鉱夫サーバー起動完了: http://0.0.0.0:${PORT}`);
});