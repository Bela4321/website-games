import { describe, expect, it } from "vitest";
import { applyMove, newGame, type Game, type Mark } from "../src/tictactoe";
import { isAllowedOrigin } from "../src/index";

function play(starter: Mark, cells: number[]): Game {
  let g = newGame(starter);
  for (const c of cells) {
    const r = applyMove(g, g.turn, c);
    if (!r.ok) throw new Error(r.error);
    g = r.game;
  }
  return g;
}

describe("rules", () => {
  it("alternates turns starting with the starter", () => {
    expect(play("O", []).turn).toBe("O");
    expect(play("O", [4]).turn).toBe("X");
    expect(play("O", [4]).board[4]).toBe("O");
  });

  it.each([
    [[0, 3, 1, 4, 2], [0, 1, 2]], // row
    [[0, 1, 3, 2, 6], [0, 3, 6]], // column
    [[0, 1, 4, 2, 8], [0, 4, 8]], // diagonal
    [[2, 0, 4, 1, 6], [2, 4, 6]], // anti-diagonal
  ])("detects a win %j", (moves, line) => {
    const g = play("X", moves);
    expect(g.winner).toBe("X");
    expect(g.line).toEqual(line);
  });

  it("a win on the ninth move is a win, not a draw", () => {
    // X O X / O X O / O X X : X completes 0-4-8 with the last square
    const g = play("X", [0, 1, 2, 3, 4, 5, 7, 6, 8]);
    expect(g.board.every(Boolean)).toBe(true);
    expect(g.winner).toBe("X");
    expect(g.line).toEqual([0, 4, 8]);
  });

  it("calls a draw on a full board with no line", () => {
    const g = play("X", [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(g.winner).toBe("draw");
    expect(g.line).toBeNull();
  });

  it("rejects bad moves without changing the game", () => {
    const g = play("X", [4]);
    expect(applyMove(g, "X", 0)).toEqual({ ok: false, error: "It's not your turn." });
    expect(applyMove(g, "O", 4)).toMatchObject({ ok: false, error: "That square is taken." });
    for (const cell of [-1, 9, 1.5, "3", null, undefined, NaN]) {
      expect(applyMove(g, "O", cell)).toMatchObject({ ok: false });
    }
    const over = play("X", [0, 3, 1, 4, 2]);
    expect(applyMove(over, "O", 8)).toMatchObject({ ok: false, error: "The game is over." });
  });
});

describe("origin allow-list", () => {
  const env = { ALLOWED_ORIGINS: "https://belaschinke.com, https://*--belaschinke.netlify.app" };
  it.each([
    ["https://belaschinke.com", true],
    ["https://deploy-preview-12--belaschinke.netlify.app", true],
    ["http://belaschinke.com", false],
    ["https://evil.com", false],
    ["https://belaschinke.com.evil.com", false],
    ["https://x.evil.com/--belaschinke.netlify.app", false],
    ["https://a.b--belaschinke.netlify.app", false],
  ])("%s -> %s", (origin, ok) => {
    expect(isAllowedOrigin(origin, env)).toBe(ok);
  });
});
