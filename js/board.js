/* board.js — square rendering and click-to-move input. */
(function (root) {
  'use strict';
  var Chess = root.Chess;
  var GLYPH = { wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
                bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F' };
  var GLYPH_LETTERS = { wk: 'K', wq: 'Q', wr: 'R', wb: 'B', wn: 'N', wp: 'P',
                         bk: 'k', bq: 'q', br: 'r', bb: 'b', bn: 'n', bp: 'p' };
  var FILES = 'abcdefgh';
  var NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

  function Board(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.flipped = !!this.opts.flipped;
    this.game = new Chess(this.opts.fen || undefined);
    this.selected = null;
    this.lastMove = null;
    this.interactive = this.opts.interactive !== false;
    this.allowedColor = this.opts.allowedColor || null; // 'w' | 'b' | null = both
    this.pieceSet = this.opts.pieceSet || 'glyph'; // 'glyph' | 'letters'
    this.showCoords = this.opts.showCoords !== false;
    // Solid shapes for both sides (colour then comes from CSS): an outline
    // white king disappears on a light board, as the site themes have.
    this.solidPieces = !!this.opts.solidPieces;
    this.marks = [];
    this.pendingPromotion = null;   // the four promotion moves, while the picker is open
    // The one square in the tab order (a roving tabindex): Tab reaches the board once,
    // the arrow keys move over all 64 squares, Enter or Space picks a square up or drops on it.
    this.cursor = null;
    this.refocus = false;   // put focus back on the cursor after the next render
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', 'Chess board. Arrow keys move between squares; Enter picks a piece up and puts it down.');
    this.el.addEventListener('click', this.onClick.bind(this));
    this.el.addEventListener('keydown', this.onKey.bind(this));
    this.render();
  }

  // Runtime update (e.g. from Settings) without recreating the board.
  Board.prototype.setDisplayOptions = function (opts) {
    opts = opts || {};
    if (opts.pieceSet !== undefined) this.pieceSet = opts.pieceSet;
    if (opts.showCoords !== undefined) this.showCoords = opts.showCoords;
    if (opts.solidPieces !== undefined) this.solidPieces = !!opts.solidPieces;
    this.render();
  };

  Board.prototype.setFen = function (fen, lastMove) {
    this.game = new Chess(fen);
    this.selected = null;
    this.lastMove = lastMove || null;
    this.render();
  };

  Board.prototype.setGame = function (game, lastMove) {
    this.game = game;
    this.selected = null;
    this.lastMove = lastMove || null;
    this.render();
  };

  Board.prototype.flip = function () { this.flipped = !this.flipped; this.render(); };

  Board.prototype.render = function () {
    var g = this.game, self = this;
    var arr = g.boardArray();
    var order = [];
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) order.push([r, f]);
    if (this.flipped) order.reverse();

    var legalFrom = {};
    if (this.interactive) {
      g.generate().forEach(function (m) { (legalFrom[m.fromSq] = legalFrom[m.fromSq] || []).push(m); });
    }
    var targets = {};
    if (this.selected && legalFrom[this.selected]) {
      legalFrom[this.selected].forEach(function (m) { targets[m.toSq] = true; });
    }
    var checkSq = null;
    if (g.inCheck()) checkSq = Chess.algebraic(g.kings[g.turn]);

    // the cursor stays where it is; with none yet, it starts on a piece that can move,
    // else on the bottom-left corner
    if (!this.cursor || !/^[a-h][1-8]$/.test(this.cursor)) {
      var firstMovable = null;
      order.forEach(function (rf) {
        var nm = FILES[rf[1]] + (8 - rf[0]), pc = arr[rf[0]][rf[1]];
        if (!firstMovable && legalFrom[nm] && (!self.allowedColor || (pc && pc.color === self.allowedColor))) firstMovable = nm;
      });
      this.cursor = firstMovable || (this.flipped ? 'h8' : 'a1');
    }
    var glyphs = this.pieceSet === 'letters' ? GLYPH_LETTERS : GLYPH;
    // which glyph family a side is drawn from: with solid pieces, white uses the filled shapes too
    var solid = this.solidPieces && glyphs === GLYPH;
    function shapeOf(colour) { return solid ? 'b' : colour; }
    var html = '';
    order.forEach(function (rf) {
      var r = rf[0], f = rf[1];
      var name = FILES[f] + (8 - r);
      var piece = arr[r][f];
      var cls = ['sq', (r + f) % 2 === 0 ? 'light' : 'dark'];
      if (self.selected === name) cls.push('sel');
      if (self.lastMove && self.lastMove.from === name) cls.push('from');
      if (self.lastMove && self.lastMove.to === name) cls.push('to');
      if (checkSq === name) cls.push('check');
      if (targets[name] && piece) cls.push('occupied');
      var canMove = self.interactive && legalFrom[name] &&
        (!self.allowedColor || (piece && piece.color === self.allowedColor));
      if (canMove || targets[name]) cls.push('movable');
      var mark = self.marks.indexOf(name) > -1;

      var label = name + ', ' + (piece ? (piece.color === 'w' ? 'white ' : 'black ') + NAMES[piece.type] : 'empty') +
        (self.selected === name ? ', selected' : '') + (targets[name] ? ', a move to here' : '');
      html += '<div class="' + cls.join(' ') + '" data-sq="' + name + '" role="button" tabindex="' +
        (name === self.cursor ? '0' : '-1') + '" aria-label="' + label + '">';
      if (piece) html += '<span class="piece ' + piece.color + '">' + glyphs[shapeOf(piece.color) + piece.type] + '</span>';
      if (targets[name]) html += '<span class="dot"></span>';
      if (mark) html += '<span class="arrowmark"></span>';
      if (self.showCoords) {
        var edgeRank = self.flipped ? f === 7 : f === 0;
        var edgeFile = self.flipped ? r === 0 : r === 7;
        if (edgeRank) html += '<span class="coord r">' + (8 - r) + '</span>';
        if (edgeFile) html += '<span class="coord f">' + FILES[f] + '</span>';
      }
      html += '</div>';
    });
    if (this.pendingPromotion) {
      var colour = g.turnColor();
      html += '<div class="promo-pick" role="group" aria-label="Promote to">' + ['q', 'r', 'b', 'n'].map(function (p) {
        return '<button type="button" data-promo="' + p + '" aria-label="' +
          { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p] + '"><span class="piece ' + colour + '">' +
          glyphs[shapeOf(colour) + p] + '</span></button>';
      }).join('') + '</div>';
    }
    // Rebuilding the squares drops keyboard focus; put it back where it was.
    var focused = (document.activeElement && this.el.contains(document.activeElement)) || this.refocus;
    this.refocus = false;
    this.el.innerHTML = html;
    if (this.pendingPromotion) {
      var first = this.el.querySelector('[data-promo]');
      if (first) first.focus();
    } else if (focused) {
      var again = this.el.querySelector('[data-sq="' + this.cursor + '"]');
      if (again) again.focus();
    }
  };

  // Move the cursor by files and ranks as the board is seen (a flipped board turns
  // the arrows around with it), stopping at the edge.
  Board.prototype.moveCursor = function (df, dr) {
    if (this.flipped) { df = -df; dr = -dr; }
    var f = FILES.indexOf(this.cursor[0]) + df, r = +this.cursor[1] + dr;
    if (f < 0 || f > 7 || r < 1 || r > 8) return;
    this.cursor = FILES[f] + r;
    var sq, all = this.el.querySelectorAll('[data-sq]');
    for (var i = 0; i < all.length; i++) all[i].tabIndex = all[i].dataset.sq === this.cursor ? 0 : -1;
    sq = this.el.querySelector('[data-sq="' + this.cursor + '"]');
    if (sq) sq.focus();
  };

  Board.prototype.onKey = function (e) {
    if (e.key === 'Escape' && this.pendingPromotion) { this.pendingPromotion = null; this.render(); return; }
    if (e.target.closest('[data-promo]')) return;   // a picker button: its own click fires
    var sq = e.target.closest('[data-sq]');
    if (!sq) return;
    var step = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (step) { e.preventDefault(); this.cursor = sq.dataset.sq; this.moveCursor(step[0], step[1]); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.handleSquare(sq.dataset.sq);
  };

  Board.prototype.onClick = function (e) {
    var promo = e.target.closest('[data-promo]');
    if (promo && this.pendingPromotion) {
      var chosen = this.pendingPromotion.filter(function (c) { return Chess.SYM[c.promo] === promo.dataset.promo; })[0];
      this.pendingPromotion = null;
      this.refocus = true;   // the picker is gone: focus goes back to the board, on the promotion square
      if (chosen && this.opts.onMove) this.opts.onMove(chosen, this.game);
      else this.render();
      return;
    }
    if (this.pendingPromotion) { this.pendingPromotion = null; this.render(); return; }   // clicked away: cancel
    var sq = e.target.closest('[data-sq]');
    if (!sq) return;
    this.handleSquare(sq.dataset.sq);
  };

  Board.prototype.handleSquare = function (name) {
    this.cursor = name;   // after a move, keyboard focus stays on the square the piece went to
    if (!this.interactive) { this.render(); return; }
    var g = this.game;
    var piece = g.get(name);
    if (this.selected) {
      var candidates = g.generate().filter(function (m) {
        return m.fromSq === this.selected && m.toSq === name;
      }.bind(this));
      if (candidates.length) {
        var chosen = candidates[0];
        if (candidates.length > 1) { // promotion: ask, rather than always queening
          if (this.opts.promptPromotion) {
            var want = this.opts.promptPromotion();
            var found = candidates.filter(function (c) { return Chess.SYM[c.promo] === want; })[0];
            if (found) chosen = found;
          } else {
            this.selected = null;
            this.pendingPromotion = candidates;
            this.render();
            return;
          }
        }
        this.selected = null;
        if (this.opts.onMove) this.opts.onMove(chosen, g);
        return;
      }
    }
    if (piece && (!this.allowedColor || piece.color === this.allowedColor) && piece.color === g.turnColor()) {
      this.selected = (this.selected === name) ? null : name;
    } else {
      this.selected = null;
    }
    this.render();
  };

  Board.GLYPH = GLYPH;
  Board.GLYPH_LETTERS = GLYPH_LETTERS;
  root.Board = Board;
})(typeof window !== 'undefined' ? window : globalThis);
