# Race API

Node/json-server API prepared for Render free web service deployment.

## Deploy on Render

1. Push this repository to GitHub.
2. In Render, create a new Blueprint from the repository, or create a Web Service manually.
3. Use these settings if creating the service manually:
   - Runtime: Node
   - Instance type: Free
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/health`
   - Environment variable: `NODE_VERSION=20.18.0`

The server listens on `process.env.PORT`, which Render provides automatically.

## Note about free hosting

This API writes data to `db.json`. Render free web services use an ephemeral filesystem, so data written at runtime can be lost after restarts or deploys. For persistent production data, move the data store to an external database.
