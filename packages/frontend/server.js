import { createServer } from 'node:http';

const port = Number(process.env.PORT || 5120);
const host = process.env.HOST || '0.0.0.0';

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>2048</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: #fffdf8;
      --text: #2f2a25;
      --muted: #7a6d5f;
      --grid: #b7a99a;
      --cell: #cdc1b4;
      --btn: #8f7a66;
      --btn-hover: #7a6755;
      --tile-2: #eee4da;
      --tile-4: #ede0c8;
      --tile-8: #f2b179;
      --tile-16: #f59563;
      --tile-32: #f67c5f;
      --tile-64: #f65e3b;
      --tile-128: #edcf72;
      --tile-256: #edcc61;
      --tile-512: #edc850;
      --tile-1024: #edc53f;
      --tile-2048: #edc22e;
      --tile-super: #3c3a33;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 15% -20%, #fff8ea 0%, transparent 45%),
        radial-gradient(circle at 85% 120%, #e8dac8 0%, transparent 40%),
        var(--bg);
      color: var(--text);
    }

    .game {
      width: min(92vw, 520px);
      background: var(--panel);
      border: 1px solid #dccfbf;
      border-radius: 20px;
      padding: 18px;
      box-shadow: 0 20px 46px rgba(54, 39, 24, 0.15);
    }

    .header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: clamp(44px, 9vw, 60px);
      line-height: 1;
      letter-spacing: -1px;
    }

    .stats {
      display: flex;
      gap: 8px;
    }

    .score-box {
      background: #bbada0;
      color: #fff;
      border-radius: 10px;
      padding: 8px 12px;
      text-align: center;
      min-width: 84px;
    }

    .score-box .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.85;
    }

    .score-box .value {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.1;
    }

    .bar {
      margin: 14px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 14px;
    }

    .btn {
      border: 0;
      background: var(--btn);
      color: #fff;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }

    .btn:hover { background: var(--btn-hover); }

    .board-wrap {
      position: relative;
      margin-top: 10px;
      border-radius: 12px;
      overflow: hidden;
    }

    .board {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      background: var(--grid);
      padding: 10px;
      border-radius: 12px;
      touch-action: none;
    }

    .cell,
    .tile {
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-weight: 700;
      user-select: none;
    }

    .cell { background: var(--cell); }

    .tile {
      font-size: clamp(24px, 7vw, 34px);
      color: #776e65;
      transition: transform 90ms ease-out;
    }

    .tile-2 { background: var(--tile-2); }
    .tile-4 { background: var(--tile-4); }
    .tile-8 { background: var(--tile-8); color: #fff; }
    .tile-16 { background: var(--tile-16); color: #fff; }
    .tile-32 { background: var(--tile-32); color: #fff; }
    .tile-64 { background: var(--tile-64); color: #fff; }

    .tile-128,
    .tile-256,
    .tile-512,
    .tile-1024,
    .tile-2048 {
      color: #fff;
      font-size: clamp(20px, 6vw, 30px);
    }

    .tile-128 { background: var(--tile-128); }
    .tile-256 { background: var(--tile-256); }
    .tile-512 { background: var(--tile-512); }
    .tile-1024 { background: var(--tile-1024); }
    .tile-2048 { background: var(--tile-2048); }

    .tile-super {
      background: var(--tile-super);
      color: #fff;
      font-size: clamp(18px, 5vw, 26px);
    }

    .overlay {
      position: absolute;
      inset: 0;
      background: rgba(238, 228, 218, 0.72);
      display: none;
      place-items: center;
      text-align: center;
      padding: 20px;
    }

    .overlay.show { display: grid; }

    .overlay .panel {
      background: rgba(255, 255, 255, 0.88);
      border: 1px solid #d5c8b8;
      border-radius: 12px;
      padding: 16px;
      max-width: 320px;
    }

    .tips {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="game">
    <div class="header">
      <h1>2048</h1>
      <div class="stats">
        <div class="score-box">
          <div class="label">Score</div>
          <div id="score" class="value">0</div>
        </div>
        <div class="score-box">
          <div class="label">Best</div>
          <div id="best" class="value">0</div>
        </div>
      </div>
    </div>

    <div class="bar">
      <div>合并数字，冲到 2048。</div>
      <button id="restart" class="btn">重新开始</button>
    </div>

    <div class="board-wrap">
      <div id="board" class="board" aria-label="2048 board"></div>
      <div id="overlay" class="overlay">
        <div class="panel">
          <h2 id="overlayTitle" style="margin:0 0 8px;">游戏结束</h2>
          <p id="overlayText" style="margin:0 0 12px;">再来一局。</p>
          <button id="overlayBtn" class="btn">继续</button>
        </div>
      </div>
    </div>

    <div class="tips">操作：方向键 / WASD / 手机滑动</div>
  </main>

  <script>
    const SIZE = 4;
    const boardEl = document.getElementById('board');
    const scoreEl = document.getElementById('score');
    const bestEl = document.getElementById('best');
    const restartBtn = document.getElementById('restart');
    const overlay = document.getElementById('overlay');
    const overlayTitle = document.getElementById('overlayTitle');
    const overlayText = document.getElementById('overlayText');
    const overlayBtn = document.getElementById('overlayBtn');

    let board = [];
    let score = 0;
    let won = false;
    let gameOver = false;
    const best = Number(localStorage.getItem('game2048_best') || 0);
    bestEl.textContent = String(best);

    function emptyBoard() {
      return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    }

    function randomEmptyCell() {
      const empty = [];
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          if (board[r][c] === 0) empty.push([r, c]);
        }
      }
      if (empty.length === 0) return null;
      return empty[Math.floor(Math.random() * empty.length)];
    }

    function addRandomTile() {
      const pos = randomEmptyCell();
      if (!pos) return;
      const [r, c] = pos;
      board[r][c] = Math.random() < 0.9 ? 2 : 4;
    }

    function rotateRight(mat) {
      const out = emptyBoard();
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          out[c][SIZE - 1 - r] = mat[r][c];
        }
      }
      return out;
    }

    function slideLeftLine(line) {
      const compact = line.filter((n) => n !== 0);
      const merged = [];
      let gained = 0;
      for (let i = 0; i < compact.length; i += 1) {
        if (compact[i] !== 0 && compact[i] === compact[i + 1]) {
          const value = compact[i] * 2;
          merged.push(value);
          gained += value;
          i += 1;
        } else {
          merged.push(compact[i]);
        }
      }
      while (merged.length < SIZE) merged.push(0);
      return { line: merged, gained };
    }

    function performMove(direction) {
      if (gameOver) return false;
      let rotated = board.map((row) => [...row]);
      const rotateTimes = { left: 0, up: 3, right: 2, down: 1 }[direction];
      for (let i = 0; i < rotateTimes; i += 1) rotated = rotateRight(rotated);

      let changed = false;
      let gainedTotal = 0;
      for (let r = 0; r < SIZE; r += 1) {
        const before = rotated[r].join(',');
        const { line, gained } = slideLeftLine(rotated[r]);
        rotated[r] = line;
        gainedTotal += gained;
        if (before !== line.join(',')) changed = true;
      }

      for (let i = 0; i < (4 - rotateTimes) % 4; i += 1) rotated = rotateRight(rotated);
      if (!changed) return false;

      board = rotated;
      score += gainedTotal;
      addRandomTile();
      updateBest();
      render();
      checkGameState();
      return true;
    }

    function canMove() {
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          const v = board[r][c];
          if (v === 0) return true;
          if (r < SIZE - 1 && v === board[r + 1][c]) return true;
          if (c < SIZE - 1 && v === board[r][c + 1]) return true;
        }
      }
      return false;
    }

    function updateBest() {
      const currentBest = Number(localStorage.getItem('game2048_best') || 0);
      if (score > currentBest) {
        localStorage.setItem('game2048_best', String(score));
        bestEl.textContent = String(score);
      } else {
        bestEl.textContent = String(currentBest);
      }
    }

    function checkGameState() {
      let maxTile = 0;
      for (const row of board) {
        for (const v of row) maxTile = Math.max(maxTile, v);
      }
      if (!won && maxTile >= 2048) {
        won = true;
        showOverlay('你赢了', '已经达到 2048，可继续挑战更高分。', '继续游戏');
      } else if (!canMove()) {
        gameOver = true;
        showOverlay('游戏结束', '棋盘已满且无法合并。', '再来一局');
      }
    }

    function tileClass(value) {
      if (value <= 0) return 'cell';
      if (value > 2048) return 'tile tile-super';
      return 'tile tile-' + value;
    }

    function render() {
      boardEl.innerHTML = '';
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          const value = board[r][c];
          const node = document.createElement('div');
          node.className = tileClass(value);
          node.textContent = value === 0 ? '' : String(value);
          boardEl.appendChild(node);
        }
      }
      scoreEl.textContent = String(score);
    }

    function showOverlay(title, text, buttonText) {
      overlayTitle.textContent = title;
      overlayText.textContent = text;
      overlayBtn.textContent = buttonText;
      overlay.classList.add('show');
    }

    function hideOverlay() {
      overlay.classList.remove('show');
    }

    function restart() {
      board = emptyBoard();
      score = 0;
      won = false;
      gameOver = false;
      addRandomTile();
      addRandomTile();
      hideOverlay();
      render();
      updateBest();
    }

    function onKeyDown(e) {
      const map = {
        ArrowLeft: 'left',
        ArrowUp: 'up',
        ArrowRight: 'right',
        ArrowDown: 'down',
        a: 'left',
        w: 'up',
        d: 'right',
        s: 'down',
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      performMove(dir);
    }

    let touchStartX = 0;
    let touchStartY = 0;

    boardEl.addEventListener(
      'touchstart',
      (e) => {
        const t = e.changedTouches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
      },
      { passive: true }
    );

    boardEl.addEventListener(
      'touchend',
      (e) => {
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;
        const threshold = 24;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          performMove(dx > 0 ? 'right' : 'left');
        } else {
          performMove(dy > 0 ? 'down' : 'up');
        }
      },
      { passive: true }
    );

    overlayBtn.addEventListener('click', () => {
      if (gameOver) restart();
      else hideOverlay();
    });
    restartBtn.addEventListener('click', restart);
    document.addEventListener('keydown', onKeyDown);

    restart();
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const reqUrl = req.url || '/';
  if (reqUrl === '/' || reqUrl === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (reqUrl === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'frontend-2048' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(port, host, () => {
  console.log(`2048 running at http://${host}:${port}`);
});
