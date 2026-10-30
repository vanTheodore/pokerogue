<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# Migración de PokéRogue a SvelteKit + Bun (+ Elysia en fase posterior)

> **Estado:** Fase A (auditoría y diseño) completada · Fase B (integración inicial de SvelteKit) implementada y ejecutable.
> Fases C, D y E diseñadas y **no** implementadas todavía.
>
> **Alcance de este documento:** estado original auditado, arquitectura objetivo, fronteras,
> riesgos, decisiones técnicas, criterios de aceptación y qué se ha verificado realmente.
>
> Última actualización: 2026-10-30 · Base: `pagefaultgames/pokerogue@d7a5ecd` (`beta`)

---

## 0. Resumen ejecutivo

El repositorio **ya estaba al día** en la mayor parte del *stack* objetivo: Phaser 4.2, TypeScript 6.0,
Vite 8.3 y Vitest 4. Lo que faltaba era (a) un anfitrión de aplicación moderno, (b) un ciclo de vida
explícito para la instancia de Phaser y (c) un flujo de desarrollo con Bun.

Esta fase entrega:

| Entrega | Estado |
| --- | --- |
| Auditoría de ambos forks (`pokerogue`, `rogueserver`) | ✅ Hecha |
| `docs/MIGRATION-PLAN.md` (este documento) | ✅ |
| SvelteKit 3 + Svelte 5 (runes) como aplicación anfitriona, Phaser sigue siendo el motor | ✅ Funcionando |
| Extracción del arranque de Phaser a un módulo reutilizable con contrato explícito | ✅ |
| Garantía de instancia única / destrucción / HMR | ✅ Con pruebas |
| Flujo de desarrollo con Bun (instalación, dev, build, test) | ✅ |
| Pruebas unitarias de las nuevas fronteras | ✅ 53 pruebas, todas en verde (7 ficheros) |
| Build heredado (MPA) sin regresión de bundle | ✅ Medido (+0.5 kB, ver §10) |
| Suite Vitest heredada | ⏳ En ejecución al cerrar la fase (ver §11) |
| Verificación en navegador real (Playwright) | ✅ **6/6 pruebas** en Chromium real, local y en CI (§11.1) |
| Verificación del **artefacto compilado** (`build/`, `adapter-static`) | ✅ **12/12 pruebas** de Playwright contra el build servido estáticamente (§14) |
| `svelte-check` sobre componentes `.svelte` | ✅ 0 errores, 0 avisos (2 576 ficheros) |
| Fronteras host ↔ juego en `dependency-cruiser` | ✅ 4 reglas nuevas, verificadas con violaciones temporales (§14.2) |
| Viabilidad de preview en Cloudflare Workers Free | ❌ **No cabe**: 31 163 ficheros frente a 20 000 (`docs/PREVIEW.md` §5) |
| Backend Elysia | ❌ Fase D (no iniciada, a propósito) |

**Lo que NO se ha hecho, y por qué:** no se migró el backend (el usuario lo pidió explícitamente),
no se convirtieron los menús del juego a Svelte, no se sustituyó el pipeline de build heredado y no se
desplegó nada.

---

## 1. Estado original auditado

### 1.1 Inicialización de Phaser y ciclo de vida

`src/main.ts` (49 líneas) era el único punto de entrada:

1. Efectos de importación, en orden sensible: `#app/polyfills` → `#init/init-manifest` (hace
   `await fetch("/manifest.json")`, **top-level await**) → `#app/i18n`.
2. `document.title += " (Beta)"` e `isMobile`/`preventDoubleTapZoom()`.
3. `await document.fonts.load("16px emerald")` y `"10px pkmnems"` (con `catch` no fatal).
4. `initSettingsManager()` → `initGlobalAudioManager()`.
5. `await import()` de `LoadingScene` y `BattleScene`.
6. `new Phaser.Game({...})` con: `type: WEBGL`, `parent: "app"`, `audio.noAudio = !audioManager.isAudioEnabled`,
   `scale 1920x1080 FIT`, 3 plugins globales (rex InputText, BBCodeText, TransitionImagePack),
   1 plugin de escena (rexUI), `input.mouse/touch.target = "app"`, `gamepad: true`,
   `dom.createContainer: true`, `antialias: false`, `scene: [LoadingScene, BattleScene]`, `version`.
7. `game.sound.pauseOnBlur = isMobile()`.

**Hallazgos relevantes:**

- No existía **ningún** manejo del ciclo de vida: ni `destroy()`, ni manejo de HMR, ni protección
  contra doble inicialización. `Phaser.Game` se creaba y se dejaba vivir para siempre.
- `LoadingScene` registra un plugin global desde su constructor
  (`Phaser.Plugins.PluginCache.register("Loader", CacheBustedLoaderPlugin, "load")`), por lo que crear
  más de una instancia de Phaser tiene efectos secundarios sobre un **caché global**.
- El estado global del juego está en singletons de módulo (`globalScene`, `settings`, `audioManager`,
  `eventBus`, `timedEventManager`), no en la instancia de Phaser (`src/globals/*`). Consecuencia: crear
  una segunda instancia no "reinicia" el juego, sino que corrompe el estado del primero.
- El audio no arranca con el juego: `initGlobalAudioManager()` crea un `AudioManager` propio
  (`src/audio/audio-manager.ts`) que gestiona BGM/SE fuera de Phaser, con `Phaser` solo como consumidor.

### 1.2 Responsabilidades: motor vs. interfaz vs. reglas

| Capa | Dónde vive | Observaciones |
| --- | --- | --- |
| Motor (Phaser) | `src/battle-scene.ts` (≈4 k líneas), `src/loading-scene.ts`, `src/scene-base.ts` | Phaser renderiza, gestiona input, tweens, audio de Phaser y el canvas. |
| Reglas de juego | `src/phases/**`, `src/field/**`, `src/data/**`, `src/modifier/**`, `src/ai/**` | TypeScript puro, sin DOM. Frontera ya limpia. |
| UI del juego | `src/ui/**` (~50 handlers) | Construida con objetos Phaser (Text/Container), **no** es DOM ni Svelte. |
| Estado/gestión | `src/system/game-data.ts` (72 kB), `src/system/settings/*`, `src/account.ts` | Persistencia y sesión. |
| Shell de aplicación | `index.html` + `index.css` | Contiene metadatos, fuentes, service worker y el **markup de los controles táctiles**. |

La conclusión importante: **las reglas del juego ya no dependen del DOM**, y la UI está construida con
objetos de Phaser. El "frontend modernizable" es el *shell*, no la UI del juego.

### 1.3 Escenas, sprites, assets, sonido, controles, localización

- **Escenas:** 2 (`loading`, `battle`). Todo el juego vive dentro de `BattleScene`, que delega en
  `PhaseManager`. `LoadingScene.preload()` pide ~600 assets individuales (`loadImage`/`loadAtlas`/
  `loadSpritesheet`), con variantes `_legacy` para temas de UI antiguos y *cache busting* vía
  `getCachedUrl()`.
- **Assets:** submódulo `pagefaultgames/pokerogue-assets` (~1.6 GB), servido como directorio público
  (Vite `publicDir` en dev, copiado en build). `manifest.json` + `globalManifest` permiten mapear rutas
  con hash.
- **Sprites:** cargados en runtime desde `assets/images/**` (no empaquetados por el bundler, salvo
  animaciones de batalla generadas). Variantes *shiny*/variantes de color gestionadas por
  `src/sprites/*`.
- **Sonido:** dos sistemas. Phaser (`game.sound`) para efectos ligados a la escena y `AudioManager`
  propio para BGM/volume settings; el flag de audio global decide `audio.noAudio` **en el config**.
- **Controles:** teclado (`settings-keyboard`), gamepad (`settings-gamepad`), ratón/táctil (Phaser
  input + `src/touch-controls.ts`). Los controles táctiles son **DOM estático** (`#touchControls` en
  `index.html`) con listeners que sintetizan eventos de teclado; `TouchControl` se inicializa con
  `document.querySelectorAll("[data-key]")`. Requiere que ese markup exista *antes* del arranque.
- **Localización:** `i18next` + subproceso de backend HTTP + detector de idioma. Los *namespaces* se
  inyectan en tiempo de build por un plugin de Vite (`plugins/vite/namespaces-i18n-plugin.ts`) que
  reemplaza `const nsEn = [];` en `src/i18n.ts`. También registra `FontFace` y `unicodeRange` por idioma.
  **La localización depende del pipeline de build**, no solo del código.

### 1.4 Persistencia, autenticación y backend

- **Modo invitado** (`VITE_BYPASS_LOGIN=1`): todo se guarda en `localStorage`, cifrado con AES
  (`crypto-js`) y clave derivada del usuario (`data_<user>`, `sessionData<slot>_<user>`), 5 *slots*.
- **Modo cuenta:** `Authorization: <base64(token de 32 bytes)>` + `PKR-Client-Version: <version>` en
  todas las peticiones; la cookie de sesión es solo un contenedor del token. `src/api/*` envuelve
  `fetch` con `ApiBase`, sin reintentos ni cancelación.
- **Contratos cliente → servidor** (inventario completo, extraído del cliente):

| Método | Ruta | Cuerpo/params | Respuesta |
| --- | --- | --- | --- |
| GET | `/account/info` | — | `UserInfo` |
| POST | `/account/register` | form-urlencoded `username,password` | texto (error) o 200 |
| POST | `/account/login` | form-urlencoded `username,password` | `{token}` |
| POST | `/account/changepw` | form-urlencoded `password` | `{token}` |
| GET | `/account/logout` | — | 200 |
| GET | `/game/titlestats` | — | `{playerCount,battleCount}` |
| GET | `/daily/seed` | — | `{seed}` |
| GET | `/savedata/system/get` | query `datatype` | `SystemSaveData` |
| GET | `/savedata/system/verify` | query `datatype` | 200/4xx |
| POST | `/savedata/system/update` | JSON `SystemSaveData` | 200 |
| GET | `/savedata/session/get` | query `slot,clientSessionId` | `SessionSaveData` |
| POST | `/savedata/session/update` | query `slot,clientSessionId` + JSON | 200 |
| GET | `/savedata/session/newclear` | query `slot,clientSessionId` | boolean |
| GET | `/savedata/session/delete` | query `slot,clientSessionId` | 200 |
| POST | `/savedata/session/clear` | query `slot,clientSessionId` + JSON | 200 |
| POST | `/savedata/updateall` | JSON `{system,session}` | texto |
| POST | `/auth/{discord,google}/logout` | — | 200 |
| POST/GET | `/admin/account/*` | form/query | admin |

### 1.5 `rogueserver`: contratos, dependencias de la implementación en Go

Proyecto independiente (Go 1.22, `net/http` con `ServeMux` de patrones, **sin framework**) y
**MySQL** (`go-sql-driver/mysql`), con **S3 opcional** para `systemSaveData`.

- **Esquema** (`db/db_setup.go`): `accounts` (uuid `BINARY(16)`, `hash BINARY(32)`, `salt BINARY(16)`,
  `trainerId`, `secretId`, `discordId`, `googleId`, `banned`), `sessions` (`token BINARY(32)` PK,
  `expire = UTC_TIMESTAMP() + 1 WEEK`), `accountStats`, `dailyRuns`, `dailyRunCompletions`,
  `accountDailyRuns`, `sessionSaveData` (`data LONGBLOB`), `systemSaveData` (`data LONGBLOB`),
  `activeClientSessions` (`clientSessionId`).
- **Criptografía:** `argon2.IDKey` (parámetros en `api/account/common.go`), `TokenSize = 32`,
  tokens aleatorios (`crypto/rand`), sesión con caducidad de una semana.
- **Compresión:** los blobs de guardado se comprimen con **zstd** (`klauspost/compress`). Formato:
  JSON → zstd → `LONGBLOB`. Esto es parte del contrato de datos (no solo de almacenamiento).
- **Validación de integridad** en el servidor: `gameStats.playTime` no puede retroceder
  (`ErrGreaterPlaytime`), `trainerId`/`secretId` deben coincidir (`ErrIdMismatch`), versión mínima
  `1.12.0.10` y comparación de versión frente al guardado existente, y `appliedMigrators` debe ser
  coherente (`ErrMigratorsDesynced`). Además rechaza un guardado con `waveIndex` menor para el mismo
  `seed`.
- **Tareas de fondo:** `robfig/cron` para ranking diario y refresco de estadísticas
  (`playerCount`, `battleCount`, `classicSessionCount`), inicialización del *seed* diario.
- **Dependencias de la implementación (lo que NO se puede migrar "gratis"):** `discordgo` (roles de
  admin por guild), OAuth de Discord/Google, AWS SDK v2 (S3), `gob` (solo para tipos internos de
  `daily`), `cron`, y el esquema MySQL con `ON DELETE CASCADE`.

**Riesgo principal:** el servidor no es un CRUD: aplica **reglas antimanipulación** y versionado de
guardados. Una reimplementación que "funcione" pero relaje esas reglas sería una regresión de
seguridad, no una migración.

### 1.6 Pruebas, herramientas, submódulos y CI

- **Pruebas:** Vitest 4 + jsdom + `vitest-canvas-mock` + `msw`, `isolate: false` con *sequencer*
  determinista. ~140 archivos de test, incluida una batalla completa en jsdom. `typecheck` = `tsc`
  (sin *emit*). `test/**` cubre reglas, fases, IA, UI y settings.
- **Herramientas:** Biome 2 (lint+format), `ls-lint` (nombres de fichero), `lefthook` (git hooks),
  `dependency-cruiser` (fronteras de módulos), Typedoc, scripts de mantenimiento (`vite-node`).
- **Submódulos:** `assets` (rama `beta`) y `locales` (rama `main`). **Sin ellos el proyecto no
  compila ni ejecuta pruebas** (el plugin de namespaces hace `readdirSync("./locales/en")` al cargar
  la config de Vite/Vitest).
- **CI:** 15 workflows. `linting.yml` (Biome + ls-lint + typecheck + depcruise), `tests.yml` (shards,
  merge de reports, coverage), `deploy*.yml`, `export-game-data.yml`, `update-submodule.yml`.
  Todo con **pnpm** y Node 24.
- **Contrato de build heredado:** `plugins/vite/static-shell-plugin.ts` reescribe `dist/index.html`
  para que sea *deploy-invariant* y cargue el bundle desde `asset-manifest.json` (iOS "Add to Home
  Screen"); `vite-minify-json-plugin.ts` copia/minifica el directorio público. Cualquier cambio de
  pipeline debe conservar esto hasta que se migre conscientemente.

### 1.7 Qué se puede adaptar directamente vs. qué necesita migración progresiva

| Parte | Veredicto |
| --- | --- |
| Configuración de Phaser (`main.ts`) | **Extraíble directamente** → hecho (`src/host/game-config.ts`) |
| Secuencia de arranque | **Extraíble directamente** → hecho (`src/host/boot-game.ts`) |
| Shell HTML (metadatos, fuentes, controles táctiles, service worker) | **Reutilizable tal cual** como plantilla de SvelteKit → hecho (`src/app.html`) |
| `index.css` | **Reutilizable tal cual** (importado por el layout) |
| Escenas, reglas, datos, IA, UI de Phaser | **No tocar** (reescribirlos no aporta valor y rompe upstream) |
| Menús del juego (`src/ui/**`) | **Conservar en Phaser**; migrar solo si aparece una necesidad real (§7) |
| `src/api/*` | **Migración progresiva** (Fase C: contratos tipados/validación compartida) |
| Persistencia (`game-data.ts`) | **Migración progresiva y cuidadosa** (Fase C/E) |
| Backend Go | **Reescritura por fases con pruebas de equivalencia** (Fase D), nunca big-bang |

---

## 2. Arquitectura objetivo

```
┌──────────────────────────────────────────────────────────────────────┐
│ SvelteKit 3 (aplicación anfitriona)                                  │
│  src/app.html        shell estático: metadatos, fuentes, #app,       │
│                      #touchControls, registro del service worker     │
│  src/routes/         +layout.svelte (index.css) · +page.svelte       │
│                      (ciclo de vida + UI de error/estado)            │
└───────────────┬──────────────────────────────────────────────────────┘
                │  contrato explícito: GameHost (start/dispose/snapshot)
┌───────────────▼──────────────────────────────────────────────────────┐
│ Capa host (nueva, `src/host/`)                                       │
│  game-host.ts    instancia única, estados, suscripción, HMR          │
│  game-config.ts  fábrica pura de Phaser.Types.Core.GameConfig        │
│  boot-game.ts    secuencia de arranque (polyfills→manifest→i18n→      │
│                  settings→audio→escenas→Phaser)                      │
└───────────────┬──────────────────────────────────────────────────────┘
                │  (sin cambios)
┌───────────────▼──────────────────────────────────────────────────────┐
│ Juego (código original, sin reestructurar)                           │
│  LoadingScene · BattleScene · phases/ · field/ · data/ · ui/ · ...   │
└──────────────────────────────────────────────────────────────────────┘

Backend (Fase D, aún Go en producción):
  Cliente src/api/*  ──HTTP──▶  rogueserver (Go+MySQL)  ‖  elysia (Bun+SQLite) en paralelo
```

### 2.1 Propiedad del estado y de los eventos (contrato)

| Estado | Propietario | Consumidores |
| --- | --- | --- |
| Instancia de `Phaser.Game` | `GameHost` (singleton de módulo) | Svelte (solo lectura), tests |
| Escenas, render, input, tweens | Phaser | — |
| Reglas de juego y fases | `BattleScene`/`PhaseManager` (código original) | — |
| Shell HTML, layout, rutas, CSS global | SvelteKit | — |
| Estado de UI "fuera del canvas" (errores de arranque, estado del host) | Svelte 5 (`$state`) | usuario |
| Ajustes, saves, sesión | singletons originales (`settings`, `game-data`) | juego y API |

Regla de oro aplicada: **Svelte no escribe nunca dentro de `#app`** (el contenedor de Phaser), y
Phaser no escribe nunca fuera de `#app`. El único cruce es `GameHost`.

---

## 3. Decisiones técnicas (y sus alternativas descartadas)

### D1 — SvelteKit con configuraciones de Vite **separadas**, no un modo nuevo de Vite

`vite.config.ts` (heredado, MPA + Vitest) se mantiene; el host usa `vite.config.app.ts`, que reutiliza
`sharedConfig()` exportado con `legacyShell: false`.

- **Por qué:** `import.meta.env.MODE` determina `isDev`/`isBeta` en `src/constants/app-constants.ts`.
  Usar `--mode sveltekit` habría roto silenciosamente el logging de desarrollo, la URL del servidor
  local y la marca `(Beta)`. Un segundo fichero de config conserva el modo estándar.
- **Alternativa descartada:** monorepo con la app en `apps/web` (recomendación de SvelteKit 3 para
  `files`). Multiplica los cambios de configuración, obliga a importar código de juego desde fuera del
  *root* de la app y **dificulta los merges de upstream**. Se reevalúa en Fase E si el backend pasa a
  vivir en el mismo repo.

### D2 — Convenciones por defecto de SvelteKit dentro de `src/`

`src/routes/`, `src/app.html` y `src/lib` (no usado) son las rutas convencionales; no se sobreescribe
`kit.files.*` salvo `assets` (que apunta al submódulo existente). Alternativa descartada: reubicar la
configuración en `sveltekit/` con `files.*`, que está **deprecado** en SvelteKit 3.

### D2b — Los componentes `.svelte` usan imports **relativos**, no alias `#`

Medido en SvelteKit 3.1 + Vite 8: `resolve.tsconfigPaths` funciona en módulos `.ts` de los entornos
*client* y *SSR*, pero **no** al importar desde un fichero `.svelte` dentro del entorno SSR. Un
`import { x } from "#app/..."` dentro de un componente rompe `vite build` con
`Rolldown failed to resolve import`. Por eso `src/routes/**` usa rutas relativas y
`test/tests/host/route-imports.test.ts` lo verifica. El alias `#host/*` existe para los tests y para
módulos `.ts`; dentro de la capa host se usan imports relativos por la misma razón.

### D3 — `adapter-static` (SPA) ahora, `adapter-bun` cuando haya servidor

El juego es 100 % cliente: no hay nada que renderizar en servidor. `adapter-static` con fallback
`200.html` reproduce el hosting actual y no introduce superficie de servidor. `@sveltejs/adapter-bun`
solo tiene sentido cuando exista el backend Elysia o rutas `+server.ts` reales (Fase D/E).
`ssr = false` en `+layout.ts` es explícito: ni Phaser ni `#app/i18n` son seguros en Node.

### D4 — `#app` y `#touchControls` siguen viviendo en la plantilla HTML, no en Svelte

`index.css` depende de la estructura (`body:has(> #touchControls.visible) #app`,
`#app > div:first-child`) y el juego resuelve esos nodos por id. Renderizarlos desde Svelte
introduciría un wrapper de hidratación y cambiaría el layout. Se mantienen en `src/app.html`
y un test de paridad garantiza que ambas plantillas no se desincronicen.

### D5 — Síntesis de la config de Phaser en una función pura

`createPhaserGameConfig()` no toca el DOM y recibe `parent` como elemento o id. Esto hace que el
contrato sea testeable sin navegador y que el mismo objeto se use en ambos pipelines.

### D6 — Importación estática de Phaser dentro de `boot-game.ts`

`game-host.ts` no importa Phaser (seguro para SSR). `boot-game.ts` sí lo hace **estáticamente** para
que la cadena `main.ts → boot-game → game-config → phaser` siga siendo un único grafo, igual que antes
de la extracción. Evita una cascada de peticiones adicional en el arranque en frío (verificado en §10).

### D7 — Bun como gestor de paquetes y runtime de desarrollo

`bun install` **lee** `pnpm-workspace.yaml` y copia `overrides`, `patchedDependencies` y
`onlyBuiltDependencies` a `package.json` (comportamiento real, verificado). Eso resuelve el riesgo de
divergencia: el parche de `@material/material-color-utilities` y los *overrides* de seguridad siguen
aplicándose. Se conservan `pnpm-lock.yaml` **y** `bun.lock`: el primero es de upstream (seguirá
cambiando al integrar upstream), el segundo da reproducibilidad a Bun. Ver §12 para el procedimiento.

### D7b — `server.fs.allow` incluye la raíz del proyecto en dev

SvelteKit restringe el *allow list* de Vite a `kit.files.src`/rutas/`outDir`. La hoja de estilos
compartida (`./index.css`, en la raíz) quedaba **fuera** y el servidor de desarrollo devolvía 403 al
pedirla, dejando el layout sin CSS en dev (el build de producción no se veía afectado). Se añadió
`server.fs.allow: [process.cwd()]` **solo** al config del host. Detectado sondeando el dev server con
`curl` (`/index.css` → 403 antes, 200 después).

### D8 — Sin dependencias nuevas más allá del *stack* pedido

Añadido: `svelte`, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, `@sveltejs/adapter-static`,
`@playwright/test`. Nada de Tailwind, React, Next, npm/yarn/pnpm en el flujo nuevo, ni librerías de
estado, ni router adicional (el de SvelteKit basta).

---

## 4. Fronteras arquitectónicas (lo que se puede tocar y lo que no)

1. **`src/host/**` (nuevo)**: única capa que conoce Phaser *y* es consumida por Svelte. Sin reglas de
   juego. Sin imports de `src/ui/**`.
2. **`src/routes/**` (nuevo)**: consume solo `#host/*`. Prohibido importar escenas o `Phaser`
   directamente (rompería SSR y duplicaría el ciclo de vida).
3. **`src/app.html`**: shell estático. Debe mantener paridad con `index.html` (test automático).
4. **Juego (`src/**` salvo `host` y `routes`)**: **intocable salvo necesidad demostrable**. Svelte
   nunca debe importarse desde aquí (lo verifica `dependency-cruiser`, ver §9).
5. **`vite.config.ts`**: cambios mínimos y aditivos (parámetro `legacyShell`).

---

## 5. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
| --- | --- | --- | --- |
| R1 | Estados globales de módulo (`globalScene`, `settings`, `audioManager`) sobreviven a un `dispose()` | Re-montaje inconsistente | `GameHost` garantiza *una* instancia y `dispose()`; la inicialización de singletons es idempotente. **Pendiente (Fase C):** hooks de reseteo explícitos |
| R2 | `LoadingScene` registra un plugin en `Phaser.Plugins.PluginCache` global | Doble registro en HMR/remontaje | Instancia única + `import.meta.hot.dispose()`; validar en Playwright |
| R3 | Divergencia de markup entre `index.html` y `src/app.html` | Layout táctil roto | Test de paridad (`test/tests/host/shell-parity.test.ts`) |
| R4 | Upstream cambia `src/main.ts` o `vite.config.ts` | Conflicto de merge | `main.ts` reducido a 3 líneas; `vite.config.ts` con cambios aditivos y comentados |
| R5 | `pnpm-lock.yaml` vs `bun.lock` divergen | Dependencias distintas en CI vs local | `bun install --frozen-lockfile` en CI; revisar el lock en cada merge de upstream |
| R6 | Bun no honra alguna función de pnpm no cubierta | Diferencias sutiles de instalación | Verificado para `overrides`/`patchedDependencies`/`onlyBuiltDependencies`; CI ejecuta instalación limpia |
| R7 | El host SvelteKit se sirve sin `assets` (submódulo vacío) | 404 de assets, juego no jugable | Documentado; `handleHttpError: "warn"`, no rompe el build |
| R8 | Caché del service worker sirve un `index.html` antiguo | Pantalla en blanco tras despliegue | Pipeline heredado mantiene el shell invariante; el host estático nuevo **aún no** integra SW (Fase E) |
| R9 | `tsconfig.json` no extiende `$app/tsconfig` (aviso de SvelteKit) | `.svelte` sin typecheck | Deliberado para no alterar el typecheck del juego; se resolverá con `svelte-check` + tsconfig separado (Fase C) |
| R10 | Elysia 2 solo tiene *release candidate* (`2.0.0-rc.1`) | Inestabilidad del backend nuevo | Fase D: fijar versión exacta, empezar por contratos estables y mantener Go como *gate* |

---

## 6. Dependencias reales (auditadas)

- **Runtime del juego:** `phaser@4.2.1`, `phaser4-rex-plugins@4.2.0`, `i18next@26` (+backend,
  +detector, +korean postposition), `crypto-js` (cifrado AES de saves locales), `jszip` (export/import
  de datos), `ajv` (validación de datos de guardado), `core-js` (polyfills), `@material/material-color-utilities`
  (cuantización de color para variantes *shiny*; **requiere el parche de tipos**).
- **Build/test:** `vite@8`, `rolldown`, `oxc`, `unplugin-inline-enum` (inlinea enums en build),
  `vitest@4` + `jsdom` + `vitest-canvas-mock` + `msw`, `biome@2`, `dependency-cruiser`, `typedoc`,
  `lefthook`, `ls-lint`.
- **Host (nuevo):** `@sveltejs/kit@3.1.1`, `svelte@5.57.3`, `@sveltejs/vite-plugin-svelte@7.3.1`,
  `@sveltejs/adapter-static@4.0.1`; `@playwright/test@1.64.1` (solo pruebas).
- **Servidor (intacto):** Go 1.22 + MySQL + `argon2`, `zstd`, `discordgo`, AWS SDK v2, `cron`.
- **Acoplamientos no obvios:** la build depende de `locales/en` en tiempo de *config* (no solo de
  runtime); `index.css` asume estructura de `body`; el service worker asume un `index.html` estable;
  `package.json#version` se inyecta en Phaser y en la cabecera `PKR-Client-Version`.

---

## 7. Dónde merece la pena usar Svelte (y dónde no)

**Sí (valor demostrable):**

- Shell de la aplicación, metadatos, rutas y layout → hecho.
- Pantallas **fuera** del canvas: estado de arranque/errores, "reintentar", futura pantalla de
  selección de cuenta/login (hoy es UI Phaser), avisos legales, changelog, ajustes globales que no
  dependan del bucle de juego.
- Depuración/telemetría de desarrollo (FPS, versión, estado del host).

**No (por ahora):**

- Menús del juego (`TitlePhase`, `StarterSelect`, `ModifierSelect`, `Party`...). Están acoplados al
  `PhaseManager`, al input del juego y a los `Text`/`Container` de Phaser. Convertirlos a DOM/Svelte
  obligaría a duplicar el sistema de input, la accesibilidad visual y el escalado, con riesgo alto y
  beneficio nulo para el jugador.

**Criterio de decisión:** migrar a Svelte solo si (a) el elemento no necesita el bucle de Phaser y
(b) la migración elimina código en lugar de duplicarlo.

---

## 8. Plan por fases

### Fase A — Auditoría y diseño ✅

Este documento + inventario de contratos + riesgos + criterios de aceptación (§10).

### Fase B — Integración inicial de SvelteKit ✅ (este PR)

- `src/host/game-config.ts`: fábrica pura de la config de Phaser.
- `src/host/game-host.ts`: `GameHost` (instancia única, estados, `dispose`, HMR, *debug bridge* en dev).
- `src/host/boot-game.ts`: secuencia de arranque extraída de `main.ts`.
- `src/main.ts`: reducido a invocar `bootGame` (pipeline heredado intacto).
- `src/app.html`, `src/routes/+layout.{ts,svelte}`, `src/routes/+page.{ts,svelte}`.
- `vite.config.app.ts` + `sharedConfig({legacyShell})`.
- Scripts Bun (`start:kit`, `build:kit`, `preview:kit`, `test:e2e`).
- Pruebas: 28 nuevas (host, config, arranque, paridad de shell, guardas de rutas) + arnés Playwright.
- CI: workflow con Bun (ver §9).

**No** se ha tocado: escenas, fases, UI del juego, `src/api/*`, backend, submodules, workflows de
upstream.

### Fase C — Separación de responsabilidades (siguiente recomendada)

1. `ServiceRegistry` explícito para `settings`/`audioManager`/`game-data` con `reset()` → elimina R1.
2. Interfaces de persistencia: `SaveRepository` (sistema/sesión/slots) con implementaciones
   `LocalStorageRepository` y `HttpRepository`, para que las reglas no conozcan `fetch` ni `localStorage`.
3. `GameEvents` tipados (unión discriminada) para eventos Phaser→Svelte (p. ej. "fase actual", "guardado").
4. `svelte-check` + `tsconfig.kit.json` (resuelve R9); `dependency-cruiser` con la regla
   "`src/**` (juego) no importa `svelte`/`$app/*`" y "`src/routes/**` no importa `phaser`".
5. Primera UI Svelte real: pantalla de login/cuenta y panel de diagnóstico.

### Fase D — Backend Elysia (paralelo, no big-bang)

1. Congelar contratos en un paquete de tipos compartido (OpenAPI o JSON Schema generado).
2. Implementar en Elysia **por orden de riesgo**: `game/titlestats` → `daily/seed` → `account/*`
   → `savedata/system` → `savedata/session` → `updateall` → admin/OAuth.
3. Pruebas de equivalencia: mismas peticiones contra Go y contra Elysia, respuestas comparadas
   (incluidos códigos de estado y mensajes de error).
4. SQLite: ver §12.3 antes de escribir una línea.
5. Nunca retirar Go hasta que la matriz de equivalencia esté completa y verde.

### Fase E — Optimización y despliegue

CI con Bun, análisis de bundle, precarga de assets, memoria, viabilidad de Cloudflare Workers Free
(el juego requiere WebGL y ~1.6 GB de assets: es previsible que **no** encaje; evaluar solo preview),
`adapter-bun` + Bun en producción tras autorización explícita.

---

## 9. CI (implementado en este PR)

`.github/workflows/bun-ci.yml` es **aditivo**: no sustituye ni modifica los workflows de upstream.
Contiene dos jobs:

**`bun`** (rápido, ~5 min)

- `bun install --frozen-lockfile`
- `bun run typecheck` (falla solo por `assets/`, que en CI sí está inicializado)
- `bunx tsc -p e2e/tsconfig.json` (tipado del arnés E2E)
- `bunx biome ci` sobre los ficheros nuevos/modificados
- `bunx vitest run test/tests/host` (incluye las pruebas de ciclo de vida y de espejo Bun/pnpm)
- `bun run build` (pipeline heredado) y `bun run build:kit` (SvelteKit) + artefacto

**`e2e`** (lento, ~20-30 min, Chromium real)

- `actions/checkout` con `submodules: false`; solo se inicializa `locales` (≈20 MB)
- `actions/cache` sobre `assets/` con clave = SHA del submódulo `assets`
- si no hay caché: **clon parcial + sparse checkout** del submódulo (`images/`, `fonts/`,
  `battle-anims/` + ficheros de raíz, ≈380 MB en vez de ≈1.7 GB)
- `bunx playwright install --with-deps chromium`
- `bunx playwright test` (6 pruebas, ver `e2e/README.md`)
- en caso de fallo sube `playwright-report/` y `test-results/` (trazas)

Los workflows de upstream (pnpm) **se conservan y vuelven a estar en verde**: su único fallo era
`ERR_PNPM_OUTDATED_LOCKFILE`, corregido regenerando `pnpm-lock.yaml` (§13.1).

---

## 10. Criterios de aceptación: estado real

| Criterio | Estado | Evidencia |
| --- | --- | --- |
| El juego inicia y llega a una partida real | ✅ **Ejecutado en Chromium** | `e2e/app.spec.ts`: título → partida nueva → modo clásico → elección de inicial → inicio de partida (oleada 1) |
| Combate y transiciones funcionan | ✅ **Ejecutado** | `Gameplay › plays from the title screen into the first battle`: FIGHT → primer movimiento → turno resuelto |
| Controles y sonido | ⚠️ Controles ✅ / sonido ⚠️ | Teclado real (SUBMIT/ACTION) en E2E; controles táctiles verificados por paridad de markup; **el audio no se verifica** (los assets de audio quedan fuera de la fixture de CI, ver `e2e/README.md`) |
| Assets y traducciones cargan | ✅ | Fixture dispersa de `assets` (imágenes, fuentes, animaciones) + `locales`; la fuente `emerald` se comprueba con `document.fonts.check` |
| Sin instancias duplicadas de Phaser | ✅ | 20 pruebas de `GameHost` (incluye carreras y remontajes) + E2E de recarga y de navegación cliente |
| Regresiones de jugabilidad pasan | ✅ (con alcance declarado) | Suite heredada: 163 pasan / 4 fallan, **idéntico al baseline** `d7a5ecd`; suite completa pendiente en CI (§11.2) |
| Flujo de desarrollo con Bun | ✅ | `bun install`, `bun run start:kit`, `build`, `build:kit`, `test`, `test:e2e` |
| Sin degradación de rendimiento | ✅ (medido en build heredado) | Entry: 1.290,84 kB → 1.291,35 kB; gzip 301,24 → 301,38 kB; chunks auxiliares idénticos (§11.3) |
| Cambios permiten seguir integrando upstream | ✅ | Workflows de upstream intactos y en verde; solo ficheros de configuración existentes modificados |

---

## 11. Resultados de pruebas (ejecutadas vs. pendientes)

### 11.1 Ejecutadas en este entorno

| Comprobación | Resultado |
| --- | --- |
| `bun install --frozen-lockfile` | ✅ (parche de `@material/material-color-utilities` y `overrides` de pnpm aplicados) |
| `pnpm install --frozen-lockfile --lockfile-only` (pnpm 10.34.5, el de CI) | ✅ Tras regenerar `pnpm-lock.yaml`; ya no hay `ERR_PNPM_OUTDATED_LOCKFILE` (§13.1) |
| `bun run typecheck` | ✅ Sin errores nuevos. Los 4 preexistentes vienen de `assets/` vacío (`pokemon-sprite.test.ts`) |
| `bunx vitest run test/tests/host` | ✅ **53/53 pruebas, 7 ficheros** (ciclo de vida de la página y del host, carreras, reintento tras fallo de arranque, imports de rutas, paridad de shell, espejo Bun↔pnpm) |
| `bunx tsc -p e2e/tsconfig.json` | ✅ |
| `bun run build` (pipeline heredado) | ✅ `dist/` completo, `asset-manifest.json`, shell reescrito |
| `bun run build:kit` (SvelteKit) | ✅ `build/` estático con `index.html` + `200.html` (**sin** `locales/`: el artefacto desplegable es `build:preview`, ver §14.1) |
| `bun run preview:kit` (artefacto estático) | ✅ `GET /` 200, CSS 8.200 B |
| **`bunx playwright test` (Chromium real, WebGL por software)** | ✅ **6/6 pruebas** (`e2e/app.spec.ts`), incluida la partida completa hasta el primer turno de combate, y el remontaje por navegación cliente |
| **`bunx playwright test --config playwright.build.config.ts`** (artefacto servido estáticamente) | ✅ **12/12 pruebas** (6 de `app.spec.ts` + 6 de `preview.spec.ts`), ≈ 7 min |
| `bun run svelte-check` | ✅ 0 errores (descarta un error de tipo inyectado a propósito en un `.svelte`) |
| `bun run depcruise` | ✅ 1 269 módulos, 0 violaciones; las 4 reglas nuevas fallan con violaciones inyectadas |
| **E2E del primer turno (endurecido)** | ✅ No acepta estados intermedios: exige `turn` avanzado **y** vuelta a `CommandPhase`/`COMMAND`, o el fin del encuentro; además **PP gastado** (`leadMovePpUsed + 1`) y un `enemyHp` coherente con su máximo |
| **CI del PR (todos los workflows)** | ✅ 17/17 checks en verde: `Bun CI`, `E2E (Chromium)` (4 min 17 s), los 5 shards de tests de upstream, `Run all linters`, `Game Data Exporter`, `Lint PR title`, REUSE |
| Hosts del dev server (`allowedHosts`) | ✅ `localhost` 200 · host de preview explícito 200 · host arbitrario **403** (§13.4) |
| Subconjunto de la suite heredada (`api` + `utils` + `scenes`) | ✅ **163 pasan / 4 fallan / 2 ficheros fallan**, idéntico al baseline `d7a5ecd` (§11.2) |
| Suite Vitest completa | ⚠️ No completada en este entorno (3 GB RAM); se ejecuta en el CI de upstream |

### 11.2 No ejecutado (y por qué)

- **Suite Vitest completa**: el repositorio tiene ~140 ficheros de test que tardan decenas de minutos
  en 3 GB de RAM; se lanzó y no terminó en ~1 h (el reporter personalizado no emite salida parcial).
  Como los cambios no tocan código de juego, se ejecutó un subconjunto significativo
  (`test/tests/api`, `test/tests/utils`, `test/tests/scenes`) contra un worktree limpio de `d7a5ecd`
  para descartar regresiones. **Acción en el PR:** el resultado completo llega del `tests.yml` de
  upstream (5 shards), que vuelve a ejecutarse tras el arreglo del lockfile.
- **Fallos del subconjunto heredado (no son regresiones):** `test/tests/scenes/battle-scene.test.ts` y
  `test/tests/utils/speed-order.test.ts` fallan por *timeout* de 20 s al cargar datos de animaciones
  (`src/data/battle-anims.ts` → `populateMoveAnim`), porque el submódulo `assets` está vacío en este
  entorno. La misma ejecución sobre `d7a5ecd` en un worktree limpio da **exactamente** el mismo
  resultado (2 ficheros / 4 pruebas / 163 pasan).
- **Audio**: los assets de audio (~450 MB) quedan fuera de la fixture de CI y el runner no tiene
  dispositivo de sonido. No se verifica que suene; se verifica que el juego no se detiene cuando un
  fichero de audio falta (`e2e/README.md`).
- **Backend / contratos cliente-servidor**: fuera de alcance en esta fase (Fase D). El E2E corre con
  `VITE_BYPASS_LOGIN=1`, igual que el flujo de desarrollo de upstream.

### 11.3 Rendimiento (build heredado, mismo entorno, comparado con `d7a5ecd` en un worktree limpio)

| Chunk | Antes | Después |
| --- | --- | --- |
| entry `index-*.js` | 1.290,84 kB (gzip 301,24) | 1.291,35 kB (gzip 301,38) |
| `battle-scene-*.js` | 987,87 kB | 987,87 kB (idéntico) |
| `loading-scene-*.js` | 2.697,73 kB | 2.697,73 kB (idéntico) |
| `index-*.css` | 8,20 kB | 8,20 kB (idéntico) |

Conclusión: **+0.5 kB** por el módulo host, misma estructura de chunks y mismo grafo de carga (la
extracción no añadió ninguna petición en cascada).

### 11.4 Errores conocidos

1. `tsconfig_extends_missing`: SvelteKit sugiere extender su tsconfig. **Deliberado** (R9).
2. `vite_config_overridden`: eliminado del config del host; no debería reaparecer.
3. `prerender_http_error` para `/logo512.png` y `/manifest.webmanifest` cuando `assets/` está vacío
   (en CI el submódulo está poblado y desaparece).
4. Aviso de Biome sobre `noUnusedVariables` en `.svelte`: se desactivó **solo** para `src/routes/**/*.svelte`
   porque Biome no analiza el markup (§ D4).
5. El service worker del pipeline heredado **no** se ha integrado aún en el host SvelteKit (Fase E).
6. Los alias `#` de tsconfig no resuelven desde `.svelte` en el entorno SSR (D2b). Detectado al
   integrar el host y cubierto por un test; si SvelteKit/Vite lo arreglan, el test sigue siendo válido
   (imports relativos siempre funcionan).
7. SvelteKit avisa `app_body_unwrapped` porque `%sveltekit.body%` va dentro de `<body>`: es
   **intencionado**, `index.css` depende de que `#app`/`#touchControls` sean hijos directos (D4).
8. `/manifest.json` (generado por el despliegue del juego, no por el repo de assets) devuelve 404 en
   local. El cliente lo tolera (`src/init/init-manifest.ts` lo captura y continúa).

---

## 12. Procedimientos

### 12.1 Desarrollo local (Windows 11 + Bun)

```powershell
# 1. Prerrequisitos: Bun 1.4.4+, Git. (Node 24 no es necesario para el flujo nuevo.)
bun --version

# 2. Submódulos (assets ~1.6 GB, locales ~18 MB) — sin esto no hay juego jugable
bun run update-submodules

# 3. Dependencias (respeta el parche de @material y los overrides de seguridad)
bun install

# 4a. Host SvelteKit (nuevo)  -> http://localhost:8000
bun run start:kit

# 4b. Pipeline heredado (referencia) -> http://localhost:8000
bun run start:dev

# 5. Calidad
bun run typecheck
bun run test                 # suite heredada (larga)
bunx vitest run test/tests/host   # solo las fronteras migradas (rápido)

# 6. Builds
bun run build                # dist/ (heredado, con shell estático)
bun run build:kit            # build/ (SvelteKit estático)
bun run preview:kit

# 7. Navegador real (una vez)
bunx playwright install chromium
bun run test:e2e
```

**Modo invitado**: `.env.development` define `VITE_BYPASS_LOGIN=1`, así que no hace falta servidor.
Para probar con backend, levanta `rogueserver` en `:8001` (o el Elysia de la Fase D) y cambia
`VITE_BYPASS_LOGIN=0`.

### 12.2 Cómo integrar una nueva versión de upstream

```bash
git remote add upstream https://github.com/pagefaultgames/pokerogue.git   # una vez
git fetch upstream beta
git switch -c merge/upstream-$(date +%Y%m%d) beta   # rama de integración, NO la de esta sesión
git merge upstream/beta
```

Reglas:

1. **Conflictos esperados**: `src/main.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`,
   `.gitignore`, `biome.jsonc`. Todos los cambios nuestros son aditivos y comentados.
2. Si upstream cambia la config de Phaser: mover el cambio a `src/host/game-config.ts` **y** al test
   `game-config.test.ts`.
3. Si upstream cambia la secuencia de arranque de `main.ts`: reflejarla en `src/host/boot-game.ts`
   (el test `boot-game.test.ts` es la red de seguridad).
4. Si upstream cambia el markup de `#touchControls` en `index.html`: **replicarlo en `src/app.html`**
   (el test de paridad fallará hasta que se haga).
5. Actualizar `pnpm-lock.yaml` **y** `bun.lock` (`bun install`).
6. Re-ejecutar: `typecheck`, `test/tests/host`, `build`, `build:kit`.

### 12.3 SQLite en la Fase D: análisis previo obligatorio

Con el volumen real de este backend (una escritura de guardado cada varias olas, lecturas puntuales,
rankings diarios) **SQLite en modo WAL es suficiente para una instancia de desarrollo/pruebas**:

- Escrituras serializadas por `busy_timeout` + WAL; el patrón de escritura es *upsert por (uuid, slot)*,
  no concurrencia masiva.
- Los blobs ya son `BLOB` comprimidos con zstd: se migran **tal cual** (no reinterpretar).
- Riesgos a documentar antes de implementar: (a) sin escritura multi-proceso/multi-instancia,
  (b) `ON DELETE CASCADE` + tipos `BINARY(16)` requieren traducción (`BLOB`/`uuid` como `BLOB(16)`),
  (c) los rankings con `ORDER BY score` necesitan índices equivalentes, (d) el cron de ranking debe
  ejecutarse en un único proceso.
- Si se necesita más concurrencia o varias instancias: PostgreSQL, con el mismo contrato.
  **Decisión pendiente de validar con pruebas de carga en Fase D**, no ahora.

---

## 13. Iteración de estabilización (revisión del PR #1)

### 13.1 Lockfile de pnpm: se sincroniza, no se desactiva

Los workflows de upstream fallaban con `ERR_PNPM_OUTDATED_LOCKFILE` porque `package.json` ganó
dependencias sin regenerar `pnpm-lock.yaml`. Se regeneró con el pnpm del repo (10.34.5):

- diff **puramente aditivo** (+238 líneas, 0 eliminadas): un importador y entradas nuevas;
  ninguna versión existente cambió.
- `pnpm install --frozen-lockfile --lockfile-only` pasa ⇒ el error de CI desaparece **sin** tocar
  `frozen-lockfile` ni ningún workflow.
- `pnpm-workspace.yaml` impone `minimumReleaseAge: 1440` (1 día). `@sveltejs/kit@3.1.1` y
  `@sveltejs/adapter-static@4.0.1` se publicaron horas antes, así que se fijan `3.1.0` y `4.0.0`
  en lugar de añadir excepciones a la política o instalar con `--no-frozen-lockfile`.

### 13.2 Bun y pnpm: un solo manifiesto, verificado

Bun 1.4 lee `pnpm-workspace.yaml` **una vez** y copia `overrides`, `patchedDependencies` y
`onlyBuiltDependencies` a `package.json` (`overrides`, `patchedDependencies`, `trustedDependencies`);
después solo mira `package.json`. Consecuencias verificadas empíricamente:

- si se eliminan esos campos, `bun install` instala `@material/material-color-utilities` **sin el
  parche** (el parche desaparece de `bun.lock` y de `node_modules`) y `typecheck` se rompe;
- si upstream cambia `pnpm-workspace.yaml`, la copia queda obsoleta en silencio.

Por eso se mantiene la copia y se añade `test/tests/host/tooling-mirror.test.ts`, que compara los tres
bloques con `pnpm-workspace.yaml` y falla indicando el arreglo («edita `pnpm-workspace.yaml` y
re-ejecuta `bun install`»).

### 13.3 Ciclo de vida de Phaser: de «un singleton» a «un singleton sin carreras»

`src/host/game-host.ts` se reescribió alrededor de dos invariantes:

1. **Nunca se entrega una instancia muerta.** Cada `dispose()` incrementa una *generación*; un boot
   captura la suya y, si cambió, destruye lo que acabó de crear y **rechaza** con
   `GameHostDisposedError` en lugar de publicarlo. Antes, un `dispose()` durante el arranque devolvía
   al llamador un `Phaser.Game` ya destruido.
2. **El orden montar/desmontar no importa.** `acquire()` devuelve un *lease*; la instancia se destruye
   cuando se libera el **último**. Un remontaje (HMR, navegación cliente) que monta antes de que el
   componente anterior se desmonte ya no se queda sin juego.

Además: `dispose()` es idempotente (una sola destrucción aunque se llame N veces), `start()` comparte
un único boot entre llamadas concurrentes y la comprobación de *teardown en curso* va **antes** de la
del boot en vuelo — precisamente el orden que un test encontró invertido en la primera versión (un
`start()` que llegaba durante el desmontaje se unía al boot condenado en vez de arrancar uno nuevo).

Las 20 pruebas de `test/tests/host/game-host.test.ts` son **discriminantes**: usan un bootstrapper
inyectado y un boot resoluble a mano para reproducir de forma determinista «dispose durante boot»,
«varios dispose a la vez», «montar antes de desmontar»… Si se elimina el arreglo, fallan.

### 13.4 `server.allowedHosts`

`allowedHosts: true` desactivaba la protección contra *DNS rebinding*. Ahora la lista es cerrada por
defecto (`localhost`, `127.0.0.1`, `[::1]`) y se amplía explícitamente con
`VITE_DEV_ALLOWED_HOSTS="host1,host2"` (admite sufijos con punto inicial). Verificado en este
entorno: `localhost` → 200, host de preview declarado → 200, host arbitrario → **403**.

### 13.5 El E2E encontró un fallo real que «compilaba»

`src/routes/+layout.svelte` no declaraba `const { children } = $props()`, así que `{@render children()}`
lanzaba `children is not defined` y **la página no se montaba**. La verificación de la Fase B
(códigos HTTP 200 y markup de `src/app.html`) no podía detectarlo: hacía falta un navegador. Es el
motivo por el que los criterios de aceptación exigen Playwright y no solo «la página responde».

### 13.6 Tres defectos que solo aparecieron al ejecutar el juego de verdad

La primera ejecución real del E2E (y del CI con el submódulo `assets` poblado) destapó tres
fallos que ninguna comprobación anterior podía ver:

1. **`children` sin declarar** en `src/routes/+layout.svelte` (Svelte 5): la página lanzaba
   `children is not defined` y no montaba nada. Los sondeos HTTP seguían devolviendo 200 y el
   markup de `src/app.html` era correcto (§13.5).
2. **`/package.json` sombreado por el directorio público.** SvelteKit sirve `assets/` en la raíz
   de URL, y el submódulo de assets trae su propio `package.json`. El juego hace
   `import { version } from "#package.json"`, que el navegador pide como `/package.json?import`;
   el manejador de ficheros estáticos respondía `application/json` y el navegador se negaba a
   cargarlo como módulo (`Failed to fetch dynamically imported module`). Solo ocurría **con el
   submódulo inicializado**, por eso no se vio antes. Arreglado en `vite.config.app.ts` con un
   plugin `enforce: "pre"` que resuelve el especificador al fichero absoluto y redirige la
   petición a `/@fs/`, sin tocar el código de upstream. Un `resolve.alias` **no** sirve: sustituye
   el mapa de alias de SvelteKit y rompe `#app/*`.
3. **Service worker en desarrollo.** El submódulo también trae `service-worker.js`; registrado
   ante el servidor de desarrollo, sirve URLs de módulo obsoletas y rompe la carga dinámica. El
   E2E lo bloquea (`serviceWorkers: "block"`) porque lo que se prueba es la aplicación, no la
   caché; el build de producción conserva el service worker.

Además, el primer arranque del servidor de desarrollo pre-optimiza Phaser mientras ya responde
`200` en `/`, así que el primer test podía caer en `504 (Outdated Optimize Dep)`. `e2e/global-setup.ts`
calienta el servidor una vez antes de la suite (y falla con un mensaje claro si el juego no monta),
que es exactamente lo que hace Vite al terminar la optimización: recargar.

### 13.7 Metadatos REUSE

`bun.lock` se declara CC0-1.0/NONE junto al resto de lockfiles, `src/**/*.svelte` queda cubierto y
`docs/MIGRATION-PLAN.md` lleva su cabecera SPDX (CC-BY-NC-SA-4.0, como el resto de `docs/`).

### 13.8 El botón «Try again» destruía el juego que acababa de arrancar

La página pedía un *lease* del host al montar y lo liberaba en `retry()` antes de volver a arrancar.
Si el arranque **inicial** había fallado no quedaba ningún otro *lease*, así que el juego recién
creado se destruía en el mismo tick y la página volvía a `idle`: el reintento no reintentaba nada.

Ahora hay un único camino de arranque, `PageGameLifecycle` (`src/host/page-lifecycle.ts`), que la
página sólo instancia, arranca y para: montaje y reintento usan la misma llamada, `start()`, y el
*lease* **se conserva** mientras la página siga montada. `stop()` sigue siendo idempotente y
seguro durante el arranque (devuelve el *lease* si se para a mitad).

Las 9 pruebas de `test/tests/host/page-lifecycle.test.ts` corren contra el host real con un
bootstrapper inyectado. La prueba «should keep the instance alive when a failed boot is retried»
falla si se reintroduce el defecto (4 de 9 fallan con `expected 'idle' to be 'running'`): arranque
fallido (`status: "failed"`, `activeLeases: 0`) → `start()` → `status: "running"`,
`activeLeases: 1`, `game === games[0]` y `games[0].destroy` no se ha llamado.

### 13.9 El E2E del primer turno aceptaba un estado intermedio

El criterio anterior era «se salió de `CommandPhase` o avanzó el contador», y `CommandPhase` se
abandona en cuanto **empieza** la animación del movimiento: la prueba podía pasar sin que el
turno se hubiese resuelto. El criterio actual sólo acepta estados **terminales**:

- de vuelta al menú del jugador (`CommandPhase` + `uiModeName === "COMMAND"`) **y** con `turn`
  avanzado — `Battle.turn` sólo lo incrementan `BattleScene.newBattle` y `TurnEndPhase`, que se
  encola después de todos los movimientos del turno; o
- el encuentro terminó (party rival vacía o `waveIndex` mayor) sin estar en `MovePhase`.

Y además comprueba un efecto real e imposible de falsear con UI: el PP del movimiento inicial sube
exactamente en uno (`leadMovePpUsed`, que `move-phase.ts` consume al usar el movimiento con
independencia de impacto, fallo o inmunidad) y el `enemyHp` queda entre 0 y su máximo. El resultado
se adjunta como anotación del test para poder diagnosticar un fallo desde el log de CI.

---

## 14. Fase C.1 — artefacto compilado, `svelte-check`, fronteras y viabilidad de preview

Objetivo: dejar de validar solo el dev server. Detalle y medidas completas en
[`docs/PREVIEW.md`](PREVIEW.md).

### 14.1 El artefacto, ejecutado de verdad

`bun run build:preview` construye en modo **producción** (el modo decide sourcemaps, tree-shaking y
minificación: un "modo preview" inventado habría producido otro bundle), copia `locales/` e inspecciona
el resultado. La inspección **falla** si falta `index.html`/`200.html`, `locales/en/menu.json`,
`images/` o `fonts/`, si el bundle referencia `api.pokerogue.net`, o si el puente de observación
aparece (o falta) sin que se haya pedido.

Lo que esto encontró:

- **Las traducciones no estaban en el build.** El juego las pide en tiempo de ejecución
  (`./locales/<lang>/<ns>.json`, 96 peticiones solo hasta el título); en dev Vite las sirve por
  accidente desde la raíz del proyecto. `adapter-static` solo copia `kit.files.assets`. La primera
  versión del arreglo —un hook `closeBundle` en `vite.config.app.ts`— copiaba *antes* de que el
  adaptador escribiera `build/`, así que el adaptador la sobrescribía; ahora se hace en
  `scripts/preview/stage-locales.ts`, después de que Vite termine.
- **`kit.files.assets` acepta un solo directorio** en SvelteKit 3, así que no hay forma declarativa
  de sumar `locales/`.
- **Un build de producción apunta a `https://api.pokerogue.net`** (`.env.production`). La preview
  fuerza `VITE_BYPASS_LOGIN=1` y un `VITE_SERVER_URL` inalcanzable, y la inspección lo verifica.
- **El puente de observación es de desarrollo.** Ahora se puede activar en un build con
  `VITE_ENABLE_DEBUG_BRIDGE=1`; sin el flag, el artefacto no contiene el puente. Eso es lo que hace
  testeable el artefacto sin publicarlo.

Resultado: `playwright.build.config.ts` sirve `build/` con `scripts/preview/serve-build.ts` (semántica
de host estático) y ejecuta **las mismas** pruebas de aceptación: 6/6 de `app.spec.ts` (incluido el
primer turno) más 6 de `preview.spec.ts` (cabeceras, manifest, fallback SPA, service worker,
traducciones, guardado de invitado). Medidas: 31 163 ficheros / 314.7 MiB; 1 177 peticiones y
31.3 MiB para llegar al título.

### 14.2 Fronteras en `dependency-cruiser`

Cuatro reglas nuevas en `.dependency-cruiser.cjs`, todas comprobadas inyectando una violación real:

| Regla | Impide | Disparó con |
| --- | --- | --- |
| `game-not-to-host` | que el juego dependa de `src/host` (salvo `src/main.ts`, que comparte `bootGame`) | `src/utils/x.ts → src/host/game-host.ts` |
| `game-not-to-svelte` | que el código de juego importe `svelte`/`@sveltejs/*` | `src/utils/x.ts → node_modules/svelte` |
| `host-not-to-sveltekit-app-modules` | `$app/*` en el host (salvo el `import()` dinámico de `debug-bridge.ts`) | `src/host/x.ts → $app/navigation` |
| `host-not-to-routes` | que el host importe componentes de ruta | (ruta excluida del crucero por convención; la cubre además `route-imports.test.ts`) |

`src/routes/` sigue excluido del crucero porque sus ficheros se resuelven por convención, no por
imports (ver `options.exclude`); sus fronteras las cubren `test/tests/host/route-imports.test.ts` y
`shell-parity.test.ts`.

**No se ha introducido `ServiceRegistry`**: no hay todavía un caso que falle sin él.

### 14.3 `svelte-check`

`bun run svelte-check` con el `tsconfig.json` del juego y `--config vite.config.app.ts` (SvelteKit 3
lee su configuración del plugin de Vite, no de `svelte.config.js`). 2 576 ficheros, 0 errores. Se
verificó que **discrimina** inyectando `const oops: number = "not a number"` en un `.svelte`: sale un
error con fichero y línea.

Descartado: un `tsconfig.kit.json` que limitara el alcance a `src/host` + `src/routes`. Al reducir el
`include`, svelte-check dejaba de cargar declaraciones globales del proyecto y reportaba **15 errores
falsos** en código de juego que `tsc` acepta. Un chequeo que miente sobre código que no se ha tocado
no compensa los 10 s que ahorra.

Además, SvelteKit avisa `tsconfig_extends_missing` en cada build (sugiere `extends: "$app/tsconfig"`).
No se aplica: el `tsconfig.json` es de upstream y cambiarlo afecta a todo el repo por un aviso.

### 14.4 Preview: viable, pero no en Workers Free

Ver `docs/PREVIEW.md`. Resumen: el artefacto tiene 31 163 ficheros y el plan Free de Cloudflare
admite 20 000 (Pages y Workers Static Assets); el de pago admite 100 000. Alternativas medidas:
Static Assets + R2 (partiendo el artefacto), autohospedaje o GitHub Pages. **No se ha desplegado
nada**, y el modo invitado está verificado: partida jugable, guardado en `localStorage` que sobrevive
a una recarga y que el propio juego vuelve a encontrar (`sessionSlotId`), y cero peticiones a ningún
API.

---

## 15. Próxima fase recomendada

**Fase C (1–2 PRs pequeños):**

1. ~~Reglas de `dependency-cruiser` para las fronteras del §4~~ — **hecho en C.1** (§14.2).
2. ~~`svelte-check`~~ — **hecho en C.1**; se ejecuta en `Bun CI`.
3. ~~Estabilizar Playwright en CI, incluida la navegación cliente~~ — **hecho**: 6/6 en el PR #1 y
   12/12 contra el artefacto compilado (§14).
4. `ServiceRegistry` con `reset()`, **solo si** aparece una necesidad demostrable. Hoy no la hay: el
   host es un singleton con *leases* y generaciones, y las pruebas de carreras cubren el ciclo de
   vida. Introducirlo sin un caso que falle sería una abstracción sin valor.
5. Decidir el despliegue de la preview con los números de `docs/PREVIEW.md` §5 (Workers Paid, R2 +
   Static Assets, o autohospedaje) y, si se elige Cloudflare, generar el `manifest.json` de
   cache-busting en el workflow.

Después, **Fase D** empezando por los endpoints de solo lectura (`/game/titlestats`, `/daily/seed`) para
tener el arnés de equivalencia Go↔Elysia funcionando antes de tocar autenticación o guardados.
