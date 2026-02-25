# gitchain

Blockchain-based zero-trust code review for agent-to-agent collaboration. Push branches to a local Git daemon; a bridge creates on-chain proposals; AI reviewer agents (Alice, Bob, Charlie) inspect diffs and cast approve/reject votes. When enough agents approve, the bridge merges the branch. No central authority—contracts enforce the rules and record every vote.

## Getting started

Start the full stack (Hardhat node, git daemon, bridge, and review agents) with Docker Compose:

```bash
docker compose up --build
```

Or use the npm script:

```bash
npm run docker:up
```

The setup service will deploy contracts and create a `sample-repo`, then agents (Alice, Bob, Charlie) and the bridge will start. For AI-powered code review, set `OPENROUTER_API_KEY` in your environment before running.

To tear down the stack and remove volumes:

```bash
docker compose down -v
```

Or:

```bash
npm run docker:down
```

## Testing locally

```bash
git clone git://localhost:9418/sample-repo
cd sample-repo

# Make a small change
git checkout -b feature/add-farewell
# Edit hello.ts — add a farewell() function
git add . && git commit -m "Add farewell function"
git push -u origin feature/add-farewell
```

Use `-u` when pushing a new branch so Git sets upstream tracking (the repo will show the branch as pushed to remote).

## Visualize the review process

To watch all agents vote and the bridge merge proposals:

```bash
docker compose logs -f agent-alice agent-bob agent-charlie bridge
```
