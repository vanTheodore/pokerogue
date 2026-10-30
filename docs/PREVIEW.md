<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# Fase C.1 — Preview estática: viabilidad, medidas y condiciones

Este documento responde a una pregunta concreta: **¿se puede publicar una preview jugable del fork
en un alojamiento estático, en modo invitado y sin backend, sin romper nada de lo que ya funciona en
desarrollo?** Contiene las medidas tomadas en este entorno, las diferencias reales entre `vite dev` y
el artefacto compilado, y las condiciones — técnicas y legales — para distribuir los assets.

**Estado: nada se ha desplegado.** El PR de esta fase deja el artefacto construible, servible y
probado en local y en CI; publicarlo es una decisión posterior, con los números de §5 delante.

---

## 1. Qué es la "preview" aquí

| Pieza | Qué es |
| --- | --- |
| Artefacto | `build/`, generado por `bun run build:preview` (SvelteKit + `adapter-static`, `fallback: 200.html`) |
| Servidor de referencia | `bun run preview:static` (`scripts/preview/serve-build.ts`), semántica de host estático |
| Modo de juego | Invitado (`VITE_BYPASS_LOGIN=1`): sin cuenta, sin servidor Go, guardado en `localStorage` |
| Verificación | `bun run test:e2e:build` → `playwright.build.config.ts` contra el artefacto servido |
| Backend | **Ninguno.** No se ha migrado `rogueserver` y esta fase no lo toca |

`svelte.config.js` no existe: la configuración de SvelteKit 3 vive en `vite.config.app.ts`.

---

## 2. Construir, servir y probar

```sh
bun install
bun run update-submodules          # assets (≈377 MB en modo disperso) + locales
bun run build:preview              # producción + locales + verificación del artefacto
bun run preview:static             # http://0.0.0.0:8100
```

Para la suite E2E hace falta el puente de observación, que un build público **no** lleva:

```sh
VITE_ENABLE_DEBUG_BRIDGE=1 bun run build:preview
bun run test:e2e:build
```

Tiempos medidos en este entorno (2 vCPU, software WebGL):

| Paso | Tiempo |
| --- | --- |
| `build:preview` (build + copia de locales + inspección) | **21–24 s** |
| Inspección del artefacto | < 1 s |
| `test:e2e:build` completo (12 pruebas) | **≈ 4 min** (3.9 min medidos) |
| `test:e2e` de desarrollo (6 pruebas) | **≈ 3 min** (3.0 min medidos) |
| `svelte-check` (proyecto completo, 2 576 ficheros) | **≈ 49 s** |
| `depcruise` (1 269 módulos) | **≈ 9 s** |

---

## 3. Diferencias reales entre desarrollo y producción

Esto es lo que la Fase C.1 encontró *porque* por primera vez se ejecutó el artefacto, no el dev
server. Cada fila es una diferencia verificada, no una suposición.

| Tema | `vite dev` | `build/` (estático) | Consecuencia |
| --- | --- | --- | --- |
| Traducciones | Vite sirve cualquier fichero bajo la raíz del proyecto, así que `/locales/...` responde por accidente | Solo existe lo que copia `adapter-static` (`kit.files.assets` + salida propia) | **Roto hasta esta fase.** `scripts/preview/stage-locales.ts` copia `locales/` (1 905 ficheros, 12.4 MiB) después del build. El juego hace 96 peticiones a `/locales/*` solo para llegar al título |
| Rutas de cliente | El middleware de SvelteKit resuelve cualquier ruta | Solo `index.html` y `200.html`: `/about` no se prerenderiza | El host necesita *fallback* SPA. Nuestro servidor lo hace; en Cloudflare es `not_found_handling: "single-page-application"` |
| `index.html` vs `200.html` | — | `index.html` usa rutas **relativas** (`./_app/...`), `200.html` **absolutas** (`/_app/...`) | Un despliegue en subdirectorio funciona en `/`, pero el *fallback* profundo necesita raíz. No desplegar bajo un prefijo |
| Service worker | Bloqueado en la suite (sirve módulos obsoletos) | Se registra y activa; hoy no tiene `fetch`, así que no cachea nada | No hay que "arreglarlo", pero conviene saber que existe y que ocupa el scope `/`. La suite de build lo deja activo y comprueba que no rompe nada |
| `#package.json` | Requiere reescritura a `/@fs/` en el dev server (`packageJsonModule()`) | Se resuelve en build y queda dentro del bundle | En producción no se pide `/package.json`; el fichero del submódulo `assets` sigue servido en la raíz |
| Cache-busting de assets | — | `/manifest.json` (mapa `ruta → timestamp`) lo genera upstream **fuera del repo** (`prmanifest` en `deploy.yml`) | Sin él, `getCachedUrl()` devuelve la URL sin `?t=`: correcto, pero los assets no llevan versión. Ver §5.4 |
| Cabeceras | Las pone Vite | Las define el host | `/_app/immutable/**` → `immutable`; HTML → `no-cache`; resto, caché corta (§5.3) |
| Tamaño del bundle | Miles de módulos ESM | 46 ficheros, 6.5 MiB (1.57 MiB gzip) en `_app/` | — |
| Puente de observación | `import.meta.env.DEV` | Solo si el build se hizo con `VITE_ENABLE_DEBUG_BRIDGE=1` | Un build sin el flag **no contiene el puente**: la inspección del artefacto falla si lo encuentra |
| API de producción | — | `.env.production` apunta a `https://api.pokerogue.net` | `build:preview` fuerza `VITE_BYPASS_LOGIN=1` y `VITE_SERVER_URL` inalcanzable, y la inspección **falla** si el bundle referencia el host de producción |

---

## 4. Medidas del artefacto

`bun run build:preview` imprime el resumen y falla si algo falta:

```
[artifact] build: 31163 files, 314.7 MiB
[artifact] 29191 files under images/, fonts/ and battle-anims/
[artifact] largest: fonts/pokemon-emerald-pro.ttf (5.0 MiB), images/effects/evo_bg.mp4 (4.7 MiB), …
```

| Grupo | Ficheros | Tamaño |
| --- | --- | --- |
| `images/` | 28 255 | 238.5 MiB |
| `battle-anims/` | 929 | 50.3 MiB |
| `fonts/` | 7 | 6.9 MiB |
| `locales/` | 1 905 | 12.4 MiB |
| `_app/` (JS + CSS) | 46 | 6.5 MiB (1.57 MiB gzip) |
| **Total** | **31 163** | **314.7 MiB** |

Fichero más grande: `fonts/pokemon-emerald-pro.ttf` (5.0 MiB). Todos por debajo de los 25 MiB por
fichero de Cloudflare.

Carga real del juego (Chromium headless, software WebGL), desde `GET /` hasta el título:

| Métrica | Valor |
| --- | --- |
| Peticiones | **1 177** |
| Transferido | **31.3 MiB** |
| De ellas, imágenes | 531 |
| De ellas, traducciones | 96 |
| Chunks JS/CSS | 39 |

> Nota: el fixture usado excluye `audio/` (≈450 MB). Un despliegue real sumaría esas peticiones y
> ese tamaño; las cifras de arriba son un **mínimo**.

---

## 5. Viabilidad en Cloudflare Workers (plan Free)

### 5.1 Límites aplicables (documentación oficial, octubre 2026)

| Límite | Free | Paid |
| --- | --- | --- |
| Ficheros de *Static Assets* por versión | **20 000** | 100 000 |
| Tamaño por fichero | 25 MiB | 25 MiB |
| Peticiones al Worker | 100 000/día | sin límite |
| CPU por petición | 10 ms | 5 min |
| Peticiones a *static assets* | **gratis e ilimitadas** | gratis e ilimitadas |
| Almacenamiento de assets | sin coste | sin coste |

Cloudflare Pages (alternativa) tiene el mismo muro: **20 000 ficheros** por sitio en Free
(100 000 en planes de pago, con `PAGES_WRANGLER_MAJOR_VERSION=4`), 25 MiB por fichero, 500 builds/mes.

### 5.2 Veredicto: **no cabe en Free tal como está**

El artefacto tiene **31 163 ficheros**: un **56 % por encima** del límite de 20 000. No es un margen
que se pueda discutir con compresión ni con `.assetsignore`; habría que eliminar 11 163 ficheros.

Opciones, con su coste real:

| Opción | Cabe en Free | Coste | Trabajo |
| --- | --- | --- | --- |
| **A. Workers Paid** con el artefacto tal cual | Sí (100 000) | 5 USD/mes | Cero cambios: `wrangler` + `assets.directory = "build"` |
| **B. Split**: app + locales (1 951 ficheros) en Static Assets, `images/` + `battle-anims/` + `fonts/` en R2 con dominio propio | Sí | R2 Free: 10 GB, 1 M operaciones clase A y 10 M clase B/mes, egreso gratis | Alto: el juego pide rutas relativas; hace falta un prefijo/reescritura y revisar `kit.files.assets` |
| **C. Autohospedaje** (`bun run preview:static` detrás de un túnel o un VPS) | Sí (sin límite de ficheros) | 0 USD | Bajo, pero sin CDN ni control de acceso salvo el que se ponga delante |
| **D. GitHub Pages** | Sí (límite de 1 GB publicado) | 0 USD | Bajo, pero **público** por definición en un repo público, y sin cabeceras propias: peor encaje legal (§6) |

**Recomendación:** si la preview tiene que estar en Cloudflare, la opción **A** es la única que no
exige tocar el juego, y 5 USD/mes es menos que el tiempo de ingeniería de la opción B. La opción
**C** es la adecuada para revisar *esta* fase: cero infraestructura, cero exposición.

### 5.3 Caché y cabeceras que exigiría el despliegue

- `/_app/immutable/**` — `public, max-age=31536000, immutable` (los nombres llevan hash).
- `index.html` / `200.html` — `no-cache`, o un despliegue es invisible para quien ya visitó el sitio.
- Assets sin hash (`images/`, `fonts/`, `battle-anims/`, `locales/`) — caché corta (1 h) **y** el
  `manifest.json` de upstream, o un cambio de sprite puede tardar en llegar. En Cloudflare el
  `not_found_handling: "single-page-application"` sirve `index.html` para rutas sin fichero, igual
  que `scripts/preview/serve-build.ts`.
- El service worker actual no cachea nada; si algún día lo hace, los assets sin hash pasan a ser un
  problema de invalidación.

### 5.4 Coste de CI

- Job `Bun / typecheck / host tests / builds`: +`svelte-check` (≈50 s) +`depcruise` (≈9 s) y el build
  pasa a ser `build:preview` (mismo tiempo: 21–24 s).
- Job nuevo `E2E (built artifact)`: build con el puente + Chromium + 12 pruebas ≈ **5 min**
  (3.9 min en este entorno; en un runner de CI, con la caché fría, añadir la instalación).
- Con caché de assets caliente, el coste incremental total es ≈ 12 min por push. Con caché fría,
  sumar la descarga del fixture (~380 MB).

---

## 6. Modo invitado: qué funciona y qué no

Verificado en el artefacto compilado, no en el dev server:

| Comprobación | Resultado |
| --- | --- |
| Arranque sin backend | ✅ 0 peticiones a `api.pokerogue.net`, `apibeta`, ni al `VITE_SERVER_URL` inalcanzable |
| Partida completa jugable | ✅ título → nuevo juego → inicial → oleada 1 → primer turno resuelto |
| Guardado local | ✅ `data_Guest` (sistema) y `sessionData_Guest` (partida) en `localStorage` |
| El guardado sobrevive a una recarga | ✅ bytes idénticos tras `page.reload()` |
| El juego **encuentra** el guardado al volver | ✅ `sessionSlotId` = 0 en el título (lo asigna `TitlePhase.checkLastSaveSlot`) |
| Cuentas, sesión, ranking, daily leaderboard | ❌ No existen sin servidor. `isLocalServerConnected` es `false` y el juego omite esas rutas en vez de fallar |

Consecuencias prácticas para una preview en invitado:

- El progreso vive **en el navegador y el perfil**. Borrar datos del sitio, usar incógnito o cambiar
  de dispositivo pierde la partida. No hay sincronización, y no la habrá hasta la Fase D.
- Los saves no se cifran con secretos de servidor (`encrypt(..., bypassLogin)`), así que cualquiera
  con acceso al perfil puede leerlos: es el comportamiento upstream en invitado, no una regresión.
- El menú "Cargar partida" no abre la selección de ranura en invitado porque no hay lista de slots
  remotas; el juego detecta la partida por `lastSessionSlot` y la ofrece en el título.

---

## 7. Condiciones para distribuir los assets

No es un detalle administrativo: es la parte que decide **si** puede haber preview pública.

- **Código**: AGPL-3.0-only. Publicar el sitio obliga a ofrecer el código correspondiente —cosa que
  este fork ya hace— y a mantener los avisos SPDX y `CREDITS.md`.
- **Assets**: el submódulo `pokerogue-assets` se declara REUSE-compliant con licencia
  **CC-BY-NC-SA-4.0** para la mayoría de los assets (más CC0 para lo autogenerado), con excepciones
  explícitas en `REUSE.toml`. Eso implica **atribución**, **no uso comercial** y **compartir igual**.
  Además hay ficheros marcados como no reutilizables sin permiso (logos del proyecto) porque
  implicarían respaldo.
- **Propiedad intelectual de Pokémon**: sprites, nombres y música pertenecen a Nintendo / Creatures /
  Game Freak. Ninguna de las licencias anteriores los cubre; upstream convive con ello como fangame
  no comercial y sin ánimo de lucro.
- Por tanto, cualquier preview **pública** debe ser: no comercial (sin anuncios, sin pago, sin
  patrocinio), con atribución visible y enlace a `CREDITS.md`, sin reutilizar los logos como marca, y
  **preferiblemente con acceso restringido** (Cloudflare Access, contraseña básica, o red privada)
  mientras sea una preview de revisión.

**Decisión de esta fase:** no se despliega nada público. El artefacto se valida en local y en CI.

---

## 8. Qué queda sin verificar

- **Despliegue real en Cloudflare** (no se ha creado cuenta, Worker ni R2; los números de §5 son
  límites documentados + medidas locales).
- **Audio**: fuera del fixture; no se comprueba que suene, solo que su ausencia no detiene el juego.
- **Compresión en tránsito**: el servidor de preview no comprime; el CDN sí (gzip/brotli de 6.5 MiB
  → 1.57 MiB en `_app/`).
- **Móviles y navegadores reales**: solo Chromium headless con WebGL por software.
- **Carga concurrente y ancho de banda** de una sesión completa (aquí solo se mide hasta el título y
  un turno de combate).
- **PWA/offline**: el service worker no cachea; "añadir a inicio" no funciona sin conexión.
- **`/manifest.json`**: se sirve 404 y el juego lo tolera (§3). Regenerarlo es trabajo de la fase de
  despliegue, no de ésta.
