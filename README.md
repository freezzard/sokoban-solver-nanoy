# sokoban-solver-nanoy

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/freezzard/sokoban-solver-nanoy/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/freezzard/sokoban-solver-nanoy/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. It cuts each level into its independent rooms along the hallway, solves every room with an A* search over pushes (box positions plus the player's reachable region, least-cost box-to-goal matching over wall-only distances, dead-square and frozen-block pruning), then stitches the room plans together with shortest box-avoiding walks. On the kit's practice set it solves all five instances in exactly the optimal number of pushes — the maximum score — in under a second.

## Run it

```sh
node /bot/main.ts
```

The program reads each instance under `/input/<id>/` and writes its moves to `/output/<id>/solution.txt`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2k68scpr&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
