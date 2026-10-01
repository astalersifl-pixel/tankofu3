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

// 静的ファイルの提供（ルート直下のindex.htmlおよびpublic）
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let gameState = {
  players: [], // { id, name, scoreCards: [], eventCards: [] }
  currentTurnIndex: 0,
  isGameStarted: false,
  pendingDiscardPlayerId: null,
  decks: { actionDeck: [], mineDeck: [], eventDeck: [] },
  discardActionDeck: [], // 使用済み行動カード
  logs: []
};

function initializeDecks() {
  // 鉱山: 32枚 (石炭1点x15, 金2点x10, ダイヤ3点x5, 爆弾x2)
  let mine = [];
  for (let i = 0; i < 15; i++) mine.push({ type: 'score', name: '石炭', value: 1 });
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', name: '金', value: 2 });
  for (let i = 0; i < 5; i++) mine.push({ type: 'score', name: 'ダイヤ', value: 3 });
  for (let i = 0; i < 2; i++) mine.push({ type: 'bomb', name: '爆弾', value: 0 });

  // 行動: 20枚 (つるはし:ドリル = 7:3 -> つるはしx14, ドリルx6)
  let action = [];
  for (let i = 0; i < 14; i++) action.push('つるはし');
  for (let i = 0; i < 6; i++) action.push('ドリル');

  // イベント: 13枚 (爆破x2, 賄賂x2, 山分けx1, 公開x2, 強奪x3, 取引x3)
  let eventList = [
    { id: 'blast', name: '爆破' }, { id: 'blast', name: '爆破' },
    { id: 'bribe', name: '賄賂' }, { id: 'bribe', name: '賄賂' },
    { id: 'share', name: '山分け' },
    { id: 'reveal', name: '公開' }, { id: 'reveal', name: '公開' },
    { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' },
    { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' }
  ];

  return {
    mineDeck: shuffle(mine),
    actionDeck: shuffle(action),
    eventDeck: shuffle(eventList)
  };
}

function addEventCardToPlayer(player, evCard) {
  player.eventCards.push(evCard);
  if (player.eventCards.length > 4) {
    gameState.pendingDiscardPlayerId = player.id;
    return false;
  }
  return true;
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
  const discardPlayer = gameState.players.find(pl => pl.id === gameState.pendingDiscardPlayerId);

  gameState.players.forEach(p => {
    const opponentsList = gameState.players
      .filter(other => other.id !== p.id)
      .map(other => ({
        id: other.id,
        name: other.name,
        scoreCardCount: other.scoreCards.length,
        eventCardCount: other.eventCards.length,
        isCurrentTurn: currentTurnPlayer && currentTurnPlayer.id === other.id
      }));

    const playerLogs = gameState.logs.slice(-30).map(logItem => {
      if (typeof logItem === 'string') return logItem;
      if (logItem && typeof logItem === 'object') {
        if (logItem.playerId === p.id && logItem.privateText) {
          return logItem.privateText;
        }
        return logItem.publicText || '';
      }
      return String(logItem);
    });

    const clientState = {
      myId: p.id,
      isGameStarted: gameState.isGameStarted,
      playerCount: gameState.players.length,
      allPlayerNames: gameState.players.map(pl => pl.name),
      myHand: { scoreCards: p.scoreCards, eventCards: p.eventCards },
      opponents: opponentsList,
      deckCounts: {
        mine: gameState.decks.mineDeck ? gameState.decks.mineDeck.length : 0,
        action: gameState.decks.actionDeck ? gameState.decks.actionDeck.length : 0,
        event: gameState.decks.eventDeck ? gameState.decks.eventDeck.length : 0
      },
      isMyTurn: currentTurnPlayer && currentTurnPlayer.id === p.id,
      mustDiscard: gameState.pendingDiscardPlayerId === p.id,
      pendingDiscardPlayerId: gameState.pendingDiscardPlayerId,
      pendingDiscardPlayerName: discardPlayer ? discardPlayer.name : null,
      logs: playerLogs,
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
  let drawn = [];
  for (let i = 0; i < count; i++) {
    if (gameState.decks.mineDeck.length > 0) {
      const c = gameState.decks.mineDeck.pop();
      player.scoreCards.push(c);
      drawn.push(c);
    }
  }
  return drawn;
}

io.on('connection', (socket) => {
  // 現在の参加者数を新規接続者にも即時送信
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
    // テストもしやすいように1名以上で開始可能（動作確認時の利便性向上）
    if (gameState.players.length < 1) {
      return socket.emit('error_message', 'プレイヤーが足りません');
    }
    gameState.decks = initializeDecks();
    gameState.discardActionDeck = [];
    gameState.isGameStarted = true;
    gameState.pendingDiscardPlayerId = null;
    gameState.currentTurnIndex = 0;
    gameState.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    gameState.logs.push('ゲームを開始しました！');
    broadcastState();
  });

  // 再戦・ロビーへ戻る
  socket.on('restart_game', () => {
    gameState.isGameStarted = false;
    gameState.pendingDiscardPlayerId = null;
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
    if (gameState.pendingDiscardPlayerId === socket.id) return;

    if (gameState.decks.actionDeck.length === 0) {
      gameState.decks.actionDeck = shuffle(gameState.discardActionDeck);
      gameState.discardActionDeck = [];
      gameState.logs.push('行動山札をリシャッフルしました');
    }

    const drawn = gameState.decks.actionDeck.pop();
    gameState.discardActionDeck.push(drawn);

    if (drawn === 'つるはし') {
      const drawnCards = drawFromMine(currentPlayer, 1);
      let evTextPrivate = '';
      let evTextPublic = '';
      if (gameState.decks.eventDeck.length > 0) {
        const evCard = gameState.decks.eventDeck.pop();
        const withinLimit = addEventCardToPlayer(currentPlayer, evCard);
        if (withinLimit) {
          evTextPrivate = ' ＆ イベント1枚';
          evTextPublic = ' ＆ イベント1枚(非公開)';
        } else {
          evTextPrivate = ' ＆ イベント1枚(※手札上限超過・捨てるカードを選択中)';
          evTextPublic = ' ＆ イベント1枚(※手札上限超過・捨てるカードを選択中)';
        }
      } else {
        evTextPrivate = '（※イベント山札空）';
        evTextPublic = '（※イベント山札空）';
      }
      const cardsText = drawnCards.map(c => c.type === 'bomb' ? '💥爆弾' : `${c.name}(${c.value}点)`).join('・') || '0枚';
      gameState.logs.push({
        playerId: currentPlayer.id,
        privateText: `⛏️ あなた は【つるはし】で【${cardsText}】を採掘！${evTextPrivate}`,
        publicText: `⛏️ ${currentPlayer.name} は【つるはし】で鉱山${drawnCards.length}枚獲得！${evTextPublic}`
      });
    } else if (drawn === 'ドリル') {
      const drawnCards = drawFromMine(currentPlayer, 2);
      const cardsText = drawnCards.map(c => c.type === 'bomb' ? '💥爆弾' : `${c.name}(${c.value}点)`).join('・') || '0枚';
      gameState.logs.push({
        playerId: currentPlayer.id,
        privateText: `⚡ あなた は【ドリル】で【${cardsText}】を採掘！`,
        publicText: `⚡ ${currentPlayer.name} は【ドリル】で鉱山から${drawnCards.length}枚採掘`
      });
    }

    // 鉱山切れチェック
    if (gameState.decks.mineDeck.length === 0) {
      endGame();
      return;
    }

    // 捨てるカード選択中の場合はターンを進めずに待機
    if (gameState.pendingDiscardPlayerId === currentPlayer.id) {
      broadcastState();
      return;
    }

    nextTurn();
  });

  // 手札上限超過時のイベントカード破棄（山札の底に戻す）
  socket.on('discard_event', (payload) => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (gameState.pendingDiscardPlayerId !== socket.id) return;

    const cardIndex = (typeof payload === 'object' && payload !== null) ? payload.cardIndex : payload;
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= currentPlayer.eventCards.length) return;

    const discarded = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.decks.eventDeck.unshift(discarded);
    gameState.logs.push(`🗑️ ${currentPlayer.name} はイベント【${discarded.name}】を選んで山札に戻しました`);

    if (currentPlayer.eventCards.length <= 4) {
      gameState.pendingDiscardPlayerId = null;

      // 鉱山切れチェック
      if (gameState.decks.mineDeck.length === 0) {
        endGame();
        return;
      }
      nextTurn();
    } else {
      broadcastState();
    }
  });

  // イベントカード使用
  socket.on('use_event', (payload) => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (gameState.pendingDiscardPlayerId === socket.id) return;

    const cardIndex = (typeof payload === 'object' && payload !== null) ? payload.cardIndex : payload;
    const selectedScoreCardIndex = (typeof payload === 'object' && payload !== null) ? payload.selectedScoreCardIndex : null;
    const targetPlayerId = (typeof payload === 'object' && payload !== null) ? payload.targetPlayerId : null;

    if (!currentPlayer.eventCards[cardIndex]) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    gameState.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました`);

    // 全員にイベントカード使用・中央表示演出を通知
    io.emit('event_card_played', {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      card: { id: usedCard.id, name: usedCard.name }
    });

    // 使用後はイベント山札の一番下に戻す
    gameState.decks.eventDeck.unshift(usedCard);

    // イベント効果分岐
    if (usedCard.id === 'blast') {
      // 爆破：爆弾カードを持つプレイヤーは爆弾とランダムに選ばれた得点カード1枚を鉱山に戻しシャッフルする。誰も爆弾を持っていなければ不発となりターンは終わる。
      const bombPlayer = gameState.players.find(p => p.scoreCards.some(c => c.type === 'bomb'));
      if (bombPlayer) {
        // 爆弾を取り除く
        const bIdx = bombPlayer.scoreCards.findIndex(c => c.type === 'bomb');
        const bombCard = bombPlayer.scoreCards.splice(bIdx, 1)[0];
        gameState.decks.mineDeck.push(bombCard);

        // 得点カードからランダムに1枚取り除く
        const scoreIndices = [];
        bombPlayer.scoreCards.forEach((c, idx) => {
          if (c.type === 'score') scoreIndices.push(idx);
        });

        let returnedScoreText = '得点なし';
        if (scoreIndices.length > 0) {
          const randIdx = scoreIndices[Math.floor(Math.random() * scoreIndices.length)];
          const returnedScore = bombPlayer.scoreCards.splice(randIdx, 1)[0];
          gameState.decks.mineDeck.push(returnedScore);
          returnedScoreText = `${returnedScore.name} (${returnedScore.value}点)`;
        }

        // 鉱山山札をシャッフル
        gameState.decks.mineDeck = shuffle(gameState.decks.mineDeck);
        gameState.logs.push(`💣【爆破】発動！ ${bombPlayer.name} は爆弾と【${returnedScoreText}】を鉱山に戻してシャッフル！`);
      } else {
        gameState.logs.push('💣 誰も爆弾を持っていなかったため【爆破】は不発でした');
      }
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
        gameState.logs.push('🤝 得点カードが回収され、全員に均等に山分けされました！');
      } else {
        gameState.logs.push('🤝 全員が得点を持っていないため山分けは不発でした');
      }
    } else if (usedCard.id === 'reveal') {
      // 公開：指定された他プレイヤー（未指定ならランダム）の得点をまとめて開示
      const otherPlayers = gameState.players.filter(p => p.id !== currentPlayer.id);
      let target = null;
      if (typeof targetPlayerId === 'string') {
        target = otherPlayers.find(p => p.id === targetPlayerId);
      }
      if (!target && otherPlayers.length > 0) {
        target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
      }

      if (target) {
        const counts = { '石炭': 0, '金': 0, 'ダイヤ': 0, '爆弾': 0 };
        let totalPts = 0;
        target.scoreCards.forEach(c => {
          if (c.type === 'bomb') {
            counts['爆弾']++;
          } else {
            if (counts[c.name] === undefined) counts[c.name] = 0;
            counts[c.name]++;
            totalPts += (c.value || 0);
          }
        });

        const parts = [];
        if (counts['石炭'] > 0) parts.push(`石炭${counts['石炭']}枚`);
        if (counts['金'] > 0) parts.push(`金${counts['金']}枚`);
        if (counts['ダイヤ'] > 0) parts.push(`ダイヤ${counts['ダイヤ']}枚`);
        if (counts['爆弾'] > 0) parts.push(`💥爆弾${counts['爆弾']}枚`);

        const summary = parts.length > 0 ? parts.join('、') + ` (計${totalPts}点 / 全${target.scoreCards.length}枚)` : 'カードなし (0点)';
        gameState.logs.push(`👁️【公開】${currentPlayer.name} は ${target.name} を指名！ ➔ 手札: ${summary}`);
      } else {
        gameState.logs.push('👁️ 他に対象プレイヤーがいませんでした');
      }
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
        const target = targets[Math.floor(Math.random() * targets.length)];
        const robIdx = Math.floor(Math.random() * target.scoreCards.length);
        const robbed = target.scoreCards.splice(robIdx, 1)[0];
        currentPlayer.scoreCards.push(robbed);
        gameState.logs.push(`🦹 ${currentPlayer.name} は ${target.name} から得点を1枚奪いました！`);
      } else {
        gameState.logs.push('🦹 他プレイヤーに奪える得点がありませんでした');
      }
    } else if (usedCard.id === 'trade') {
      // 取引：使用したプレイヤーは得点カードと相手を選び、相手はランダムで得点カード1枚を交換
      const otherPlayersWithCards = gameState.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
      let partner = null;
      if (typeof targetPlayerId === 'string') {
        partner = otherPlayersWithCards.find(p => p.id === targetPlayerId);
      }
      if (!partner && otherPlayersWithCards.length > 0) {
        partner = otherPlayersWithCards[Math.floor(Math.random() * otherPlayersWithCards.length)];
      }

      if (currentPlayer.scoreCards.length > 0 && partner && partner.scoreCards.length > 0) {
        let myCardIdx = 0;
        if (typeof selectedScoreCardIndex === 'number' && selectedScoreCardIndex >= 0 && selectedScoreCardIndex < currentPlayer.scoreCards.length) {
          myCardIdx = selectedScoreCardIndex;
        } else {
          myCardIdx = Math.floor(Math.random() * currentPlayer.scoreCards.length);
        }

        const partnerCardIdx = Math.floor(Math.random() * partner.scoreCards.length);

        const myCard = currentPlayer.scoreCards.splice(myCardIdx, 1)[0];
        const partnerCard = partner.scoreCards.splice(partnerCardIdx, 1)[0];

        currentPlayer.scoreCards.push(partnerCard);
        partner.scoreCards.push(myCard);

        const myCardText = myCard.type === 'bomb' ? '💥爆弾' : `${myCard.name}(${myCard.value}点)`;
        gameState.logs.push(`🔄 ${currentPlayer.name} は【${myCardText}】を渡し、${partner.name} と得点カードを取引しました！`);
      } else {
        gameState.logs.push('🔄 交換できるカードまたは対象プレイヤーが不足しているため取引は不発でした');
      }
    } else if (usedCard.id === 'bribe') {
      // 賄賂：自分の得点のカードの一番小さい得点のカードを鉱山に戻し、イベント山札から2枚引く（手札上限4枚・超過時は手動選択破棄）
      let minVal = Infinity;
      let minIdx = -1;
      currentPlayer.scoreCards.forEach((c, idx) => {
        if (c.type === 'score' && typeof c.value === 'number' && c.value < minVal) {
          minVal = c.value;
          minIdx = idx;
        }
      });

      if (minIdx !== -1) {
        const returnedCard = currentPlayer.scoreCards.splice(minIdx, 1)[0];
        gameState.decks.mineDeck.push(returnedCard);
        gameState.decks.mineDeck = shuffle(gameState.decks.mineDeck);

        let drawnCount = 0;
        for (let i = 0; i < 2; i++) {
          if (gameState.decks.eventDeck.length > 0) {
            const evCard = gameState.decks.eventDeck.pop();
            addEventCardToPlayer(currentPlayer, evCard);
            drawnCount++;
          }
        }
        let bribeMsg = `💰 ${currentPlayer.name} は【賄賂】を使い、【${returnedCard.name} (${returnedCard.value}点)】を鉱山に戻してイベントカードを${drawnCount}枚獲得しました！`;
        if (currentPlayer.eventCards.length > 4) {
          bribeMsg += `（※手札上限4枚を超えたため、捨てるカードを選択中）`;
        }
        gameState.logs.push(bribeMsg);
      } else {
        gameState.logs.push(`${currentPlayer.name} は賄賂を使おうとしましたが、戻せる得点カードが無いため不発となりました`);
      }
    }

    if (gameState.pendingDiscardPlayerId === currentPlayer.id) {
      broadcastState();
      return;
    }

    nextTurn();
  });

  socket.on('disconnect', () => {
    const leftPlayer = gameState.players.find(p => p.id === socket.id);
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.pendingDiscardPlayerId === socket.id) {
      gameState.pendingDiscardPlayerId = null;
    }
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

  // 勝敗計算＆爆弾処理
  let results = gameState.players.map(p => {
    let cards = [...p.scoreCards];
    const bombCount = cards.filter(c => c.type === 'bomb').length;
    let destroyedCards = [];

    // 爆弾判定前の暫定得点
    let initialScore = p.scoreCards.reduce((sum, c) => sum + (typeof c.value === 'number' && c.type !== 'bomb' ? c.value : 0), 0);

    // 爆弾所持の場合、爆弾の枚数分だけダイヤ ➔ 金 ➔ 石炭の順に優先的に破壊
    for (let b = 0; b < bombCount; b++) {
      const priorityOrder = ['ダイヤ', '金', '石炭'];
      let targetIdx = -1;

      for (const cardName of priorityOrder) {
        targetIdx = cards.findIndex(c => c.type !== 'bomb' && c.name === cardName);
        if (targetIdx !== -1) break;
      }

      // フォールバック: 点数の高い順
      if (targetIdx === -1) {
        let maxVal = -1;
        cards.forEach((c, idx) => {
          if (c.type !== 'bomb' && typeof c.value === 'number' && c.value > maxVal) {
            maxVal = c.value;
            targetIdx = idx;
          }
        });
      }

      if (targetIdx !== -1) {
        const removed = cards.splice(targetIdx, 1)[0];
        destroyedCards.push(removed);
      } else {
        break; // 破壊できる得点カードがなくなった場合
      }
    }

    // 爆弾処理後の最終得点集計 (爆弾は0点扱い)
    let finalScore = cards.reduce((sum, c) => sum + (typeof c.value === 'number' && c.type !== 'bomb' ? c.value : 0), 0);
    return {
      name: p.name,
      initialScore: initialScore,
      finalScore: finalScore,
      score: finalScore, // 後方互換用
      hasBomb: bombCount > 0,
      bombCount: bombCount,
      destroyedCards: destroyedCards.map(c => ({ name: c.name, value: c.value })),
      destroyedCard: destroyedCards[0] ? { name: destroyedCards[0].name, value: destroyedCards[0].value } : null,
      totalDeductedScore: initialScore - finalScore,
      originalCount: p.scoreCards.length
    };
  });

  // 最高得点者判定 (同点は全員勝利)
  let maxScore = Math.max(...results.map(r => r.finalScore), 0);
  let winners = results.filter(r => r.finalScore === maxScore).map(r => r.name);

  gameState.logs.push(`勝者: ${winners.join(', ')} (得点: ${maxScore}点)`);
  broadcastState({ gameOver: true, results: results, winners: winners, maxScore: maxScore });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`炭鉱夫サーバー起動完了: http://0.0.0.0:${PORT}`);
});
