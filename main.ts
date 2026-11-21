// Roomwise push-optimal Sokoban solver.
//
// A generated level is a one-square hallway with small rooms opening off it, and a box can never
// leave the room it started in, so the level's push optimum is the sum of its rooms' optima. This
// program cuts the hallway out of the board, solves each room on its own with an A* search over
// pushes (never over steps), and stitches the rooms' push plans together with shortest walks.
//
// The push search carries, per state, the sorted box squares plus the lowest square of the player's
// reachable region. Its estimate is a least-cost matching of boxes to goals over wall-only walking
// distances, which never overstates the pushes still needed, and the goal test waits until a state
// is drawn from the frontier, so the first plan out is push-optimal. Two shapes are pruned on
// sight: a box landing on a square no push can bring to any goal (found by pulling back from the
// goals), and a frozen 2 x 2 block of walls and boxes holding a box off its goal. Budgets are
// counted in expanded states, never in time, so two runs of the program write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_ROOT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_ROOT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const ROOM_EXPANSION_BUDGET = 250_000;
const WHOLE_EXPANSION_BUDGET = 600_000;
const STEP_VECTORS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface BoardShape {
  width: number;
  height: number;
  wallMask: Uint8Array;
  goalCells: number[];
  boxCells: number[];
  playerCell: number;
}

interface PushPlan {
  pushes: number;
  moves: string;
}

/** The level in XSB text as arrays over cell indices, the outer frame read as wall. */
function parseBoard(levelText: string): BoardShape {
  const textRows = levelText.split('\n').filter((rowText) => rowText.length > 0);
  const height = textRows.length;
  const width = Math.max(...textRows.map((rowText) => rowText.length));
  const wallMask = new Uint8Array(width * height).fill(1);
  const goalCells: number[] = [];
  const boxCells: number[] = [];
  let playerCell = -1;
  textRows.forEach((rowText, rowIdx) => {
    for (let colIdx = 0; colIdx < rowText.length; colIdx++) {
      const glyph = rowText[colIdx]!;
      const cellIdx = rowIdx * width + colIdx;
      if (glyph === '#') {
        wallMask[cellIdx] = 1;
      }
      if (glyph !== '#') {
        wallMask[cellIdx] = 0;
        if (glyph === '.' || glyph === '*' || glyph === '+') goalCells.push(cellIdx);
        if (glyph === '$' || glyph === '*') boxCells.push(cellIdx);
        if (glyph === '@' || glyph === '+') playerCell = cellIdx;
      }
    }
  });
  for (let rowIdx = 0; rowIdx < height; rowIdx++) {
    for (let colIdx = 0; colIdx < width; colIdx++) {
      const onFrame = colIdx === 0 || rowIdx === 0 || colIdx === width - 1 || rowIdx === height - 1;
      if (onFrame) wallMask[rowIdx * width + colIdx] = 1;
    }
  }
  boxCells.sort((lhs, rhs) => lhs - rhs);
  goalCells.sort((lhs, rhs) => lhs - rhs);
  const shape: BoardShape = { width, height, wallMask, goalCells, boxCells, playerCell };
  return shape;
}

/** Walking distances from one start square over open floor, boxes ignored: -1 where unreachable. */
function walkingDistances(width: number, wallMask: Uint8Array, startCell: number): Int32Array {
  const distField = new Int32Array(wallMask.length).fill(-1);
  const walkQueue: number[] = [startCell];
  distField[startCell] = 0;
  for (let queueHead = 0; queueHead < walkQueue.length; queueHead++) {
    const cellNow = walkQueue[queueHead]!;
    for (const [stepX, stepY] of STEP_VECTORS) {
      const cellNext = cellNow + stepY * width + stepX;
      if (wallMask[cellNext] === 0 && distField[cellNext] === -1) {
        distField[cellNext] = distField[cellNow]! + 1;
        walkQueue.push(cellNext);
      }
    }
  }
  return distField;
}

/** The squares a box can sit on and still be pushed to some goal, found by pulling back from the goals. */
function liveSquaresOf(width: number, wallMask: Uint8Array, goalCells: number[]): Uint8Array {
  const liveMask = new Uint8Array(wallMask.length);
  const pullQueue: number[] = [];
  for (const goalCell of goalCells) {
    liveMask[goalCell] = 1;
    pullQueue.push(goalCell);
  }
  for (let queueHead = 0; queueHead < pullQueue.length; queueHead++) {
    const cellNow = pullQueue[queueHead]!;
    for (const [stepX, stepY] of STEP_VECTORS) {
      const stride = stepY * width + stepX;
      const boxBefore = cellNow - stride;
      const stanceBefore = boxBefore - stride;
      if (wallMask[boxBefore] === 0 && wallMask[stanceBefore] === 0 && liveMask[boxBefore] === 0) {
        liveMask[boxBefore] = 1;
        pullQueue.push(boxBefore);
      }
    }
  }
  return liveMask;
}

/** Every ordering of the goal indices, built once per room so the matching estimate stays cheap. */
function goalOrderings(goalCount: number): number[][] {
  const orderings: number[][] = [];
  const draft: number[] = [];
  const takenFlags: boolean[] = new Array(goalCount).fill(false);
  const growOrdering = (): void => {
    if (draft.length === goalCount) {
      orderings.push(draft.slice());
    }
    if (draft.length < goalCount) {
      for (let goalIdx = 0; goalIdx < goalCount; goalIdx++) {
        if (!takenFlags[goalIdx]) {
          takenFlags[goalIdx] = true;
          draft.push(goalIdx);
          growOrdering();
          draft.pop();
          takenFlags[goalIdx] = false;
        }
      }
    }
  };
  growOrdering();
  return orderings;
}

/** Whether the box just pushed onto `landedCell` froze inside a 2 x 2 block with a box off its goal. */
function frozenBlockAt(width: number, wallMask: Uint8Array, occupiedMask: Uint8Array, goalMask: Uint8Array, landedCell: number): boolean {
  let frozenVerdict = false;
  const cornerOffsets = [0, -1, -width, -width - 1];
  for (const cornerOffset of cornerOffsets) {
    const cornerCell = landedCell + cornerOffset;
    const blockCells = [cornerCell, cornerCell + 1, cornerCell + width, cornerCell + width + 1];
    let blockSolid = true;
    let blockHoldsStray = false;
    for (const blockCell of blockCells) {
      if (wallMask[blockCell] === 0 && occupiedMask[blockCell] === 0) blockSolid = false;
      if (occupiedMask[blockCell] === 1 && goalMask[blockCell] === 0) blockHoldsStray = true;
    }
    if (blockSolid && blockHoldsStray) frozenVerdict = true;
  }
  return frozenVerdict;
}

/**
 * Floods the player's reachable region from `fromCell` around walls and the boxes in `occupiedMask`,
 * stamping reached squares in `markField` with `stampValue`, and hands back the region's lowest square.
 */
function floodRegion(width: number, wallMask: Uint8Array, occupiedMask: Uint8Array, fromCell: number, markField: Int32Array, stampValue: number, floodStack: number[]): number {
  let lowestHeld = fromCell;
  floodStack.length = 0;
  floodStack.push(fromCell);
  markField[fromCell] = stampValue;
  while (floodStack.length > 0) {
    const cellNow = floodStack.pop()!;
    if (cellNow < lowestHeld) lowestHeld = cellNow;
    for (const [stepX, stepY] of STEP_VECTORS) {
      const cellNext = cellNow + stepY * width + stepX;
      if (wallMask[cellNext] === 0 && occupiedMask[cellNext] === 0 && markField[cellNext] !== stampValue) {
        markField[cellNext] = stampValue;
        floodStack.push(cellNext);
      }
    }
  }
  return lowestHeld;
}

/** The shortest walk between two squares around walls and boxes, as lower-case step letters. */
function walkLetters(width: number, wallMask: Uint8Array, occupiedMask: Uint8Array, fromCell: number, targetCell: number): string {
  let lettersFound = '';
  if (fromCell !== targetCell) {
    const cameFrom = new Int32Array(wallMask.length).fill(-1);
    const cameBy = new Array<string>(wallMask.length).fill('');
    const walkQueue: number[] = [fromCell];
    cameFrom[fromCell] = fromCell;
    for (let queueHead = 0; queueHead < walkQueue.length && cameFrom[targetCell] === -1; queueHead++) {
      const cellNow = walkQueue[queueHead]!;
      for (const [stepX, stepY, stepLetter] of STEP_VECTORS) {
        const cellNext = cellNow + stepY * width + stepX;
        if (wallMask[cellNext] === 0 && occupiedMask[cellNext] === 0 && cameFrom[cellNext] === -1) {
          cameFrom[cellNext] = cellNow;
          cameBy[cellNext] = stepLetter;
          walkQueue.push(cellNext);
        }
      }
    }
    if (cameFrom[targetCell] !== -1) {
      let lettersReversed = '';
      let cellWalk = targetCell;
      while (cellWalk !== fromCell) {
        lettersReversed += cameBy[cellWalk]!;
        cellWalk = cameFrom[cellWalk]!;
      }
      lettersFound = [...lettersReversed].reverse().join('');
    }
  }
  return lettersFound;
}

/**
 * A push-optimal plan for one room (or for a whole board when no rooms were cut): A* over pushes,
 * or a named empty-handed result when the budget runs out first. The region flood that tests push
 * stances and the flood that names a state's region keep separate mark fields and separate box
 * masks, so naming a successor can never smudge the stances of the state being expanded.
 */
function solvePushSpace(width: number, wallMask: Uint8Array, goalCells: number[], startBoxes: number[], startPlayer: number, expansionBudget: number): PushPlan | null {
  const boardSize = wallMask.length;
  const goalMask = new Uint8Array(boardSize);
  for (const goalCell of goalCells) goalMask[goalCell] = 1;
  const liveMask = liveSquaresOf(width, wallMask, goalCells);
  let planOutcome: PushPlan | null = null;
  let startDoomed = false;
  for (const boxCell of startBoxes) if (liveMask[boxCell] === 0) startDoomed = true;
  if (!startDoomed) {
    const goalDistFields = goalCells.map((goalCell) => walkingDistances(width, wallMask, goalCell));
    const matchOrderings = startBoxes.length <= 5 ? goalOrderings(goalCells.length) : [];
    const estimateOf = (boxesNow: number[]): number => {
      let estimateHeld = 0;
      if (matchOrderings.length > 0) {
        let bestMatch = Number.POSITIVE_INFINITY;
        for (const ordering of matchOrderings) {
          let matchSum = 0;
          let matchBroken = false;
          boxesNow.forEach((boxCell, boxIdx) => {
            const legDist = goalDistFields[ordering[boxIdx]!]![boxCell]!;
            if (legDist < 0) matchBroken = true;
            if (!matchBroken) matchSum += legDist;
          });
          if (!matchBroken && matchSum < bestMatch) bestMatch = matchSum;
        }
        estimateHeld = bestMatch;
      }
      if (matchOrderings.length === 0) {
        let sumHeld = 0;
        for (const boxCell of boxesNow) {
          let boxBest = Number.POSITIVE_INFINITY;
          for (const distField of goalDistFields) {
            const legDist = distField[boxCell]!;
            if (legDist >= 0 && legDist < boxBest) boxBest = legDist;
          }
          sumHeld += boxBest;
        }
        estimateHeld = sumHeld;
      }
      return estimateHeld;
    };
    // Two private workspaces: the expansion flood and the naming flood never share a mark or a mask.
    const expandOccupied = new Uint8Array(boardSize);
    const expandMarks = new Int32Array(boardSize);
    let expandStamp = 0;
    const expandStack: number[] = [];
    const namingOccupied = new Uint8Array(boardSize);
    const namingMarks = new Int32Array(boardSize);
    let namingStamp = 0;
    const namingStack: number[] = [];
    const regionNameOf = (boxesNow: number[], playerExact: number): number => {
      for (const boxCell of boxesNow) namingOccupied[boxCell] = 1;
      namingStamp += 1;
      const lowestHeld = floodRegion(width, wallMask, namingOccupied, playerExact, namingMarks, namingStamp, namingStack);
      for (const boxCell of boxesNow) namingOccupied[boxCell] = 0;
      return lowestHeld;
    };
    const keyOfState = (boxesNow: number[], regionLowest: number): string => String.fromCharCode(regionLowest, ...boxesNow);
    const stateBoxes: number[][] = [startBoxes.slice()];
    const statePlayerExact: number[] = [startPlayer];
    const statePushCount: number[] = [0];
    const stateParent: number[] = [-1];
    const statePushBoxFrom: number[] = [-1];
    const statePushDirIdx: number[] = [-1];
    const bestPushCount = new Map<string, number>();
    bestPushCount.set(keyOfState(startBoxes, regionNameOf(startBoxes, startPlayer)), 0);
    // The frontier heap: [estimated total, deeper first on ties, arrival order, state index].
    type FrontierEntry = [number, number, number, number];
    const frontier: FrontierEntry[] = [[estimateOf(startBoxes), 0, 0, 0]];
    let arrivalCounter = 0;
    const frontierBefore = (lhs: FrontierEntry, rhs: FrontierEntry): boolean => lhs[0] < rhs[0] || (lhs[0] === rhs[0] && (lhs[1] < rhs[1] || (lhs[1] === rhs[1] && lhs[2] < rhs[2])));
    const frontierPush = (entry: FrontierEntry): void => {
      frontier.push(entry);
      let slotIdx = frontier.length - 1;
      let bubbling = slotIdx > 0 && frontierBefore(frontier[slotIdx]!, frontier[(slotIdx - 1) >> 1]!);
      while (bubbling) {
        const parentIdx = (slotIdx - 1) >> 1;
        const swapHeld = frontier[slotIdx]!;
        frontier[slotIdx] = frontier[parentIdx]!;
        frontier[parentIdx] = swapHeld;
        slotIdx = parentIdx;
        bubbling = slotIdx > 0 && frontierBefore(frontier[slotIdx]!, frontier[(slotIdx - 1) >> 1]!);
      }
    };
    const frontierPop = (): FrontierEntry => {
      const topEntry = frontier[0]!;
      const lastEntry = frontier.pop()!;
      if (frontier.length > 0) {
        frontier[0] = lastEntry;
        let slotIdx = 0;
        let sinking = true;
        while (sinking) {
          let childIdx = 2 * slotIdx + 1;
          if (childIdx >= frontier.length) sinking = false;
          if (sinking) {
            if (childIdx + 1 < frontier.length && frontierBefore(frontier[childIdx + 1]!, frontier[childIdx]!)) childIdx += 1;
            if (!frontierBefore(frontier[childIdx]!, frontier[slotIdx]!)) sinking = false;
            if (sinking) {
              const swapHeld = frontier[slotIdx]!;
              frontier[slotIdx] = frontier[childIdx]!;
              frontier[childIdx] = swapHeld;
              slotIdx = childIdx;
            }
          }
        }
      }
      return topEntry;
    };
    const allOnGoals = (boxesNow: number[]): boolean => boxesNow.every((boxCell) => goalMask[boxCell] === 1);
    let expansionsSpent = 0;
    let goalStateIdx = -1;
    let frontierAlive = frontier.length > 0;
    while (frontierAlive && goalStateIdx < 0 && expansionsSpent < expansionBudget) {
      const poppedEntry = frontierPop();
      const stateIdx = poppedEntry[3];
      const boxesNow = stateBoxes[stateIdx]!;
      const pushesNow = statePushCount[stateIdx]!;
      const knownBest = bestPushCount.get(keyOfState(boxesNow, regionNameOf(boxesNow, statePlayerExact[stateIdx]!)));
      const popIsStale = knownBest !== undefined && knownBest < pushesNow;
      if (!popIsStale) {
        if (allOnGoals(boxesNow)) goalStateIdx = stateIdx;
        if (!allOnGoals(boxesNow)) {
          expansionsSpent += 1;
          for (const boxCell of boxesNow) expandOccupied[boxCell] = 1;
          expandStamp += 1;
          const regionStamp = expandStamp;
          floodRegion(width, wallMask, expandOccupied, statePlayerExact[stateIdx]!, expandMarks, regionStamp, expandStack);
          boxesNow.forEach((boxCell, boxIdx) => {
            STEP_VECTORS.forEach(([stepX, stepY], dirIdx) => {
              const stride = stepY * width + stepX;
              const stanceCell = boxCell - stride;
              const landingCell = boxCell + stride;
              const pushLegal = expandMarks[stanceCell] === regionStamp && wallMask[landingCell] === 0 && expandOccupied[landingCell] === 0 && liveMask[landingCell] === 1;
              if (pushLegal) {
                expandOccupied[boxCell] = 0;
                expandOccupied[landingCell] = 1;
                const frozenHeld = frozenBlockAt(width, wallMask, expandOccupied, goalMask, landingCell);
                expandOccupied[landingCell] = 0;
                expandOccupied[boxCell] = 1;
                if (!frozenHeld) {
                  const boxesNext = boxesNow.slice();
                  boxesNext[boxIdx] = landingCell;
                  boxesNext.sort((lhs, rhs) => lhs - rhs);
                  const keyNext = keyOfState(boxesNext, regionNameOf(boxesNext, boxCell));
                  const seenCount = bestPushCount.get(keyNext);
                  if (seenCount === undefined || seenCount > pushesNow + 1) {
                    bestPushCount.set(keyNext, pushesNow + 1);
                    const stateIdxNext = stateBoxes.length;
                    stateBoxes.push(boxesNext);
                    statePlayerExact.push(boxCell);
                    statePushCount.push(pushesNow + 1);
                    stateParent.push(stateIdx);
                    statePushBoxFrom.push(boxCell);
                    statePushDirIdx.push(dirIdx);
                    arrivalCounter += 1;
                    frontierPush([pushesNow + 1 + estimateOf(boxesNext), -(pushesNow + 1), arrivalCounter, stateIdxNext]);
                  }
                }
              }
            });
          });
          for (const boxCell of boxesNow) expandOccupied[boxCell] = 0;
        }
      }
      frontierAlive = frontier.length > 0;
    }
    if (goalStateIdx >= 0) {
      const chainIdx: number[] = [];
      for (let walkIdx = goalStateIdx; walkIdx > 0; walkIdx = stateParent[walkIdx]!) chainIdx.push(walkIdx);
      chainIdx.reverse();
      let movesBuilt = '';
      let playerHeld = startPlayer;
      let boxesHeld = startBoxes.slice();
      const walkOccupied = new Uint8Array(boardSize);
      for (const chainState of chainIdx) {
        const boxFrom = statePushBoxFrom[chainState]!;
        const dirIdx = statePushDirIdx[chainState]!;
        const stride = STEP_VECTORS[dirIdx]![1] * width + STEP_VECTORS[dirIdx]![0];
        for (const boxCell of boxesHeld) walkOccupied[boxCell] = 1;
        movesBuilt += walkLetters(width, wallMask, walkOccupied, playerHeld, boxFrom - stride);
        for (const boxCell of boxesHeld) walkOccupied[boxCell] = 0;
        movesBuilt += STEP_VECTORS[dirIdx]![3];
        playerHeld = boxFrom;
        boxesHeld = stateBoxes[chainState]!;
      }
      const planHeld: PushPlan = { pushes: chainIdx.length, moves: movesBuilt };
      planOutcome = planHeld;
    }
  }
  return planOutcome;
}

/** One room cut out of the level: its floor squares, its boxes and its goals. */
interface RoomSlice {
  squares: number[];
  boxCells: number[];
  goalCells: number[];
}

/** The rooms of a level: the dead squares of the player's row cut the floor, each part holding boxes is a room. */
function cutRooms(shape: BoardShape): RoomSlice[] | null {
  const { width, wallMask, goalCells, boxCells, playerCell } = shape;
  const liveAll = liveSquaresOf(width, wallMask, goalCells);
  const playerRow = Math.floor(playerCell / width);
  const cutMask = new Uint8Array(wallMask.length);
  for (let cellIdx = playerRow * width; cellIdx < (playerRow + 1) * width; cellIdx++) {
    if (wallMask[cellIdx] === 0 && liveAll[cellIdx] === 0) cutMask[cellIdx] = 1;
  }
  let roomsOutcome: RoomSlice[] | null = null;
  let boxInCut = false;
  for (const boxCell of boxCells) if (cutMask[boxCell] === 1) boxInCut = true;
  if (!boxInCut) {
    const partOf = new Int32Array(wallMask.length).fill(-1);
    const slices: RoomSlice[] = [];
    for (let seedCell = 0; seedCell < wallMask.length; seedCell++) {
      if (wallMask[seedCell] === 0 && cutMask[seedCell] === 0 && partOf[seedCell] === -1) {
        const sliceIdx = slices.length;
        const squares: number[] = [seedCell];
        partOf[seedCell] = sliceIdx;
        for (let queueHead = 0; queueHead < squares.length; queueHead++) {
          const cellNow = squares[queueHead]!;
          for (const [stepX, stepY] of STEP_VECTORS) {
            const cellNext = cellNow + stepY * width + stepX;
            if (wallMask[cellNext] === 0 && cutMask[cellNext] === 0 && partOf[cellNext] === -1) {
              partOf[cellNext] = sliceIdx;
              squares.push(cellNext);
            }
          }
        }
        slices.push({ squares, boxCells: [], goalCells: [] });
      }
    }
    for (const boxCell of boxCells) slices[partOf[boxCell]!]!.boxCells.push(boxCell);
    let goalsAllPlaced = true;
    for (const goalCell of goalCells) {
      if (partOf[goalCell] === -1) goalsAllPlaced = false;
      if (partOf[goalCell] !== -1) slices[partOf[goalCell]!]!.goalCells.push(goalCell);
    }
    let countsAgree = goalsAllPlaced;
    for (const slice of slices) if (slice.boxCells.length !== slice.goalCells.length) countsAgree = false;
    if (countsAgree) roomsOutcome = slices.filter((slice) => slice.boxCells.length > 0);
    if (!countsAgree) roomsOutcome = null;
  }
  return roomsOutcome;
}

/** The moves solving one level: room by room when the level cuts into rooms, whole-board when it does not. */
function solveLevel(levelText: string): string {
  const shape = parseBoard(levelText);
  const slices = cutRooms(shape);
  let movesOutcome = '';
  if (slices === null) {
    const wholePlan = solvePushSpace(shape.width, shape.wallMask, shape.goalCells, shape.boxCells, shape.playerCell, WHOLE_EXPANSION_BUDGET);
    if (wholePlan !== null) movesOutcome = wholePlan.moves;
  }
  if (slices !== null) {
    // Each room's boxes are tracked in their own list, so a solved room's new squares never blur another room's.
    const sliceCurrent: number[][] = slices.map((slice) => slice.boxCells.slice());
    let playerHeld = shape.playerCell;
    let stitchedMoves = '';
    let stitchFailed = false;
    slices.forEach((slice, sliceIdx) => {
      if (!stitchFailed) {
        const wallWithOthers = shape.wallMask.slice();
        sliceCurrent.forEach((otherBoxes, otherIdx) => {
          if (otherIdx !== sliceIdx) {
            for (const otherBox of otherBoxes) wallWithOthers[otherBox] = 1;
          }
        });
        const roomPlan = solvePushSpace(shape.width, wallWithOthers, slice.goalCells, sliceCurrent[sliceIdx]!, playerHeld, ROOM_EXPANSION_BUDGET);
        if (roomPlan === null) stitchFailed = true;
        if (roomPlan !== null) {
          stitchedMoves += roomPlan.moves;
          // Replay the room plan on this room's own boxes to learn where the player and boxes stand now.
          const roomBoxesReplay = sliceCurrent[sliceIdx]!.slice();
          const replayOccupied = new Uint8Array(shape.wallMask.length);
          for (const boxCell of roomBoxesReplay) replayOccupied[boxCell] = 1;
          sliceCurrent.forEach((otherBoxes, otherIdx) => {
            if (otherIdx !== sliceIdx) {
              for (const otherBox of otherBoxes) replayOccupied[otherBox] = 1;
            }
          });
          let playerReplay = playerHeld;
          for (const moveGlyph of roomPlan.moves) {
            const dirFound = STEP_VECTORS.find(([, , lowerGlyph, upperGlyph]) => lowerGlyph === moveGlyph || upperGlyph === moveGlyph)!;
            const stride = dirFound[1] * shape.width + dirFound[0];
            const stepTarget = playerReplay + stride;
            if (replayOccupied[stepTarget] === 1) {
              replayOccupied[stepTarget] = 0;
              replayOccupied[stepTarget + stride] = 1;
              const heldIdx = roomBoxesReplay.indexOf(stepTarget);
              roomBoxesReplay[heldIdx] = stepTarget + stride;
            }
            playerReplay = stepTarget;
          }
          roomBoxesReplay.sort((lhs, rhs) => lhs - rhs);
          sliceCurrent[sliceIdx] = roomBoxesReplay;
          playerHeld = playerReplay;
        }
      }
    });
    if (!stitchFailed) movesOutcome = stitchedMoves;
  }
  return movesOutcome;
}

for (const instanceId of readdirSync(INPUT_ROOT).sort()) {
  let movesHeld = '';
  try { movesHeld = solveLevel(readFileSync(join(INPUT_ROOT, instanceId, 'level.txt'), 'utf8')); } catch (solveErr) { movesHeld = ''; }
  mkdirSync(join(OUTPUT_ROOT, instanceId), { recursive: true });
  writeFileSync(join(OUTPUT_ROOT, instanceId, 'solution.txt'), `${movesHeld}\n`);
}
