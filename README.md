# gitchain

Blockchain-based zero-trust code review system.

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
