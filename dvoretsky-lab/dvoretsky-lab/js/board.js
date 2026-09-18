/* board.js — square rendering and click-to-move input. */
(function (root) {
  'use strict';
  var Chess = root.Chess;
  var GLYPH = { wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
                bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F' };
  var FILES = 'abcdefgh';

  function Board(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.flipped = !!this.opts.flipped;
    this.game = new Chess(this.opts.fen || undefined);
    this.selected = null;
    this.lastMove = null;
    this.interactive = this.opts.interactive !== false;
    this.allowedColor = this.opts.allowedColor || null; // 'w' | 'b' | null = both
    this.marks = [];
    this.el.addEventListener('click', this.onClick.bind(this));
    this.el.addEventListener('keydown', this.onKey.bind(this));
    this.render();
  }

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
      if (targets[name]) cls.push(piece ? 'occupied' : '');
      var canMove = self.interactive && legalFrom[name] &&
        (!self.allowedColor || (piece && piece.color === self.allowedColor));
      if (canMove || targets[name]) cls.push('movable');
      var mark = self.marks.indexOf(name) > -1;

      html += '<div class="' + cls.join(' ') + '" data-sq="' + name + '"' +
        (canMove || targets[name] ? ' tabindex="0" role="button" aria-label="' + name + '"' : '') + '>';
      if (piece) html += '<span class="piece ' + piece.color + '">' + GLYPH[piece.color + piece.type] + '</span>';
      if (targets[name]) html += '<span class="dot"></span>';
      if (mark) html += '<span class="arrowmark"></span>';
      var edgeRank = self.flipped ? f === 7 : f === 0;
      var edgeFile = self.flipped ? r === 0 : r === 7;
      if (edgeRank) html += '<span class="coord r">' + (8 - r) + '</span>';
      if (edgeFile) html += '<span class="coord f">' + FILES[f] + '</span>';
      html += '</div>';
    });
    this.el.innerHTML = html;
  };

  Board.prototype.onKey = function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var sq = e.target.closest('[data-sq]');
    if (!sq) return;
    e.preventDefault();
    this.handleSquare(sq.dataset.sq);
  };

  Board.prototype.onClick = function (e) {
    var sq = e.target.closest('[data-sq]');
    if (!sq) return;
    this.handleSquare(sq.dataset.sq);
  };

  Board.prototype.handleSquare = function (name) {
    if (!this.interactive) return;
    var g = this.game;
    var piece = g.get(name);
    if (this.selected) {
      var candidates = g.generate().filter(function (m) {
        return m.fromSq === this.selected && m.toSq === name;
      }.bind(this));
      if (candidates.length) {
        var chosen = candidates[0];
        if (candidates.length > 1) { // promotion
          var want = this.opts.promptPromotion ? this.opts.promptPromotion() : 'q';
          var found = candidates.filter(function (c) { return Chess.SYM[c.promo] === want; })[0];
          if (found) chosen = found;
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
  root.Board = Board;
})(typeof window !== 'undefined' ? window : globalThis);
