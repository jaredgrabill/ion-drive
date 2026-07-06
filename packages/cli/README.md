# @ion-drive/cli

The Ion Drive CLI (`ion-drive`) — project scaffolding and building-block
management for the Ion Drive platform.

```bash
ion-drive init my-app      # scaffold a project
ion-drive list             # browse available building blocks
ion-drive add crm          # install a block into a running server
ion-drive remove crm
ion-drive dev              # run the development loop
ion-drive schema pull|diff|push|doctor
```

Talks to a running Ion Drive server over HTTP (`--server`, default
`http://localhost:3000`).

Docs & source: https://github.com/jaredgrabill/ion-drive · License: Apache-2.0
