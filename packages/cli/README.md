# @ion-drive/cli

The Ion Drive CLI (`ion-drive`) — project scaffolding and building-block
management for the Ion Drive platform.

```bash
ion-drive init my-app      # scaffold a project
ion-drive list             # browse the default registry (--all for every one)
ion-drive add crm          # install a block into a running server
ion-drive add crm@^0.2     # semver ranges — highest satisfying version wins
ion-drive add @acme/billing@1.x   # namespaced ref → a configured registry
ion-drive remove crm
ion-drive dev              # run the development loop
ion-drive schema pull|diff|push|doctor
ion-drive registry list|add|remove|ping   # manage configured registries (--json)
ion-drive block new|validate|pack         # block-authoring toolchain
```

Registries are configured per project in `ion.config.json` (`"registries":
{ "@acme": "https://…/index.json" }`, `${ENV_VAR}` auth supported); the
official `@ion` registry is built in and is the default for bare refs.

Talks to a running Ion Drive server over HTTP (`--server`, default
`http://localhost:3000`).

Docs & source: https://github.com/jaredgrabill/ion-drive · License: Apache-2.0
