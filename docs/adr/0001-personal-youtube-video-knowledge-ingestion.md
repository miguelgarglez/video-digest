# ADR 0001: Personal YouTube Video Knowledge Ingestion

Status: Proposed  
Date: 2026-05-31

## Context

Miguel acumula videos largos de YouTube, especialmente en "Ver mas tarde", y quiere convertirlos en conocimiento util: resumenes, ideas clave, conexiones, acciones e insights que puedan alimentar una futura knowledge base personal.

El objetivo no es solo "resumir videos", sino crear un flujo de captura, digestion, entrega y memoria:

```text
Video interesante
-> transcript o analisis del contenido
-> digest estructurado
-> email personal
-> knowledge base personal
```

La primera prueba manual se hizo con:

`https://www.youtube.com/watch?v=1ZgUcrR0K7I`

Resultado:

- Se pudo abrir el video con Navegador.
- Se pudo abrir la descripcion y el panel "Mostrar transcripcion".
- Se extrajeron 850 segmentos con timestamps, desde `0:02` hasta `1:39:20`.
- Se genero y envio un digest por Gmail a `miguel.garglez@gmail.com`.
- No fue necesario esperar a anuncios ni reproducir el video completo.

## Decision

Construiremos el sistema como un pipeline personal de ingestion de conocimiento, no como una API universal de transcripts de YouTube.

La direccion recomendada es:

```text
Playlist propia "Resumir"
-> trigger/polling automatico
-> obtencion de transcript por capas
-> resumen estructurado
-> envio por email
-> guardado en knowledge base
```

Codex/Navegador queda como herramienta de exploracion, prototipado y fallback asistido, no como pieza principal de produccion.

La logica principal debe vivir en un core propio reutilizable. n8n, Vercel Cron, GitHub Actions, Cloudflare Workers, una CLI o un frontend deben ser solo interfaces/adaptadores alrededor de ese core.

```text
Core propio = que significa este video y que hacemos con el
Triggers/adaptadores = cuando y desde donde se invoca
```

## Key Conclusions

### 1. "Ver mas tarde" no es una buena fuente automatizable

La lista "Watch Later / Ver mas tarde" no es facilmente accesible por la YouTube Data API. La fuente recomendada es una playlist propia, por ejemplo:

```text
Resumir
Inbox - Para resumir
Videos para digerir
```

### 2. El trigger realista es polling, no webhook

YouTube no ofrece un webhook simple para "nuevo video agregado a playlist". La opcion practica es consultar la playlist cada cierto intervalo:

```text
Cada 30 o 60 minutos:
  leer playlist
  detectar videos no procesados
  procesar solo nuevos
```

La YouTube Data API sirve bien para esto. `playlistItems.list` tiene coste bajo de quota.

### 3. La API oficial de YouTube no resuelve transcripts publicos arbitrarios

La YouTube Data API tiene endpoints de captions, pero no son una solucion general para descargar subtitulos/transcripts de videos ajenos. Requieren autorizacion adecuada y estan pensados sobre todo para videos propios o canales con permisos.

Conclusion: la API oficial sirve para metadata/playlists, pero no como fuente principal de transcripts.

### 4. El transcript es el cuello de botella

Muchas herramientas de resumen dependen del transcript disponible en YouTube. Si el transcript:

- no existe,
- es auto-generado con baja calidad,
- esta en idioma no esperado,
- esta incompleto,
- o YouTube cambia su acceso,

el resumen tambien se degrada.

Por eso el sistema debe tener fallback y guardar metadatos de calidad.

### 5. Navegador + UI de YouTube funciona, pero es fragil

El flujo asistido con Navegador puede extraer la transcripcion desde el panel visible de YouTube. Es util para experimentos y ejecucion bajo demanda.

Riesgos:

- cambios de UI;
- idioma de interfaz;
- botones ambiguos;
- anuncios;
- paneles que cargan parcialmente;
- login/cookies;
- videos sin transcript;
- transcripciones de baja calidad.

No debe ser el mecanismo principal si el objetivo es automatizacion estable.

## Transcript Options

### Option A: `youtube-transcript-api`

Tipo: libreria Python / CLI no oficial.

Aporta:

- no requiere API key;
- no requiere navegador;
- soporta subtitulos manuales y auto-generados;
- devuelve timestamps;
- permite idiomas y traducciones cuando YouTube lo soporta.

Riesgos:

- no es oficial;
- puede sufrir bloqueos/429, especialmente en cloud;
- no genera transcript si no hay captions;
- puede requerir proxies en escenarios intensivos.

Encaje:

- excelente para MVP local;
- buena primera capa del transcript service.

### Option B: `yt-dlp`

Tipo: CLI open source.

Aporta:

- `--list-subs`;
- `--write-subs`;
- `--write-auto-subs`;
- `--skip-download`;
- salida `.vtt`, `.srt`, etc.

Riesgos:

- tambien depende de mecanismos no oficiales;
- puede requerir cookies/PO tokens en algunos casos;
- es mas CLI de extraccion que API limpia.

Encaje:

- buen fallback local;
- util para diagnosticar subtitulos disponibles.

### Option C: Supadata

Tipo: API SaaS.

Aporta:

- API/SDK;
- soporte multi-plataforma;
- modos tipo `native`, `auto`, `generate`;
- posible fallback AI si no hay transcript nativo;
- buen encaje con n8n o scripts.

Riesgos:

- coste;
- dependencia de proveedor;
- hay que validar calidad y limites.

Encaje:

- candidato fuerte para version fiable sin mantener scraping propio.

### Option D: TranscriptAPI.com

Tipo: API SaaS centrada en YouTube.

Aporta:

- REST API;
- transcripts con/sin timestamps;
- soporte para playlists/canales;
- pricing simple;
- posible integracion MCP/agentes.

Riesgos:

- proveedor pequeno;
- fallback AI menos claro;
- dependencia de mecanismos no oficiales.

Encaje:

- candidato simple para prototipo gestionado.

### Option E: Apify Actors

Tipo: scraping gestionado / actors.

Aporta:

- integracion con REST, n8n, Make, Zapier;
- scheduling, logs, webhooks;
- varios actores con captions y algunos con fallback AI.

Riesgos:

- calidad variable por actor;
- costes variables;
- vendor lock-in parcial;
- conviene benchmark con videos reales.

Encaje:

- muy interesante si se usa n8n/no-code.

### Option F: ASR propio o AI multimodal

Ejemplos: Whisper, Gemini, Deepgram, AssemblyAI.

Aporta:

- no depende de captions existentes;
- fallback para videos sin transcript;
- puede mejorar videos con captions malas.

Riesgos:

- coste mayor;
- latencia;
- descarga/procesamiento de audio/video;
- consideraciones legales y de terminos de uso;
- mas complejidad operativa.

Encaje:

- fallback, no primera capa.

## Proposed Architecture

```text
YouTube playlist "Resumir"
  -> Poller
     -> YouTube Data API: playlistItems.list
     -> State store: processed video IDs
  -> Transcript Service
     -> Try youtube-transcript-api
     -> Try yt-dlp
     -> Try SaaS provider: Supadata / TranscriptAPI / Apify
     -> Optional ASR fallback
  -> Transcript Normalizer
     -> timestamps
     -> language
     -> chunks
     -> quality score
  -> Summarizer
     -> TL;DR
     -> ideas clave
     -> timestamps relevantes
     -> acciones
     -> conceptos a investigar
     -> conexiones
     -> veredicto
  -> Delivery
     -> Gmail
     -> Markdown / Obsidian / Notion / Drive
```

## LLM Summarization Strategy

Cuando el sistema este automatizado, Codex ya no sera quien lea el transcript y razone manualmente. Esa funcion debe cubrirla una capa LLM consumida por API.

Para controlar coste, el summarizer debe ser modular y escalable por calidad:

```text
Transcript
-> cheap extraction model
   -> resumen base
   -> ideas clave
   -> timestamps relevantes
   -> tags
   -> quality flags
-> optional better model
   -> sintesis profunda
   -> conexiones entre videos
   -> insight semanal/mensual
```

Uso recomendado por defecto:

- modelo barato para resumen por video;
- modelo mas capaz solo para digest semanal, conexiones entre varios videos o videos marcados como importantes;
- Batch API cuando la latencia no importe;
- cachear resultados por `video_id + transcript_hash + prompt_version`.

Proveedor LLM del MVP:

- OpenCode Zen sera el proveedor inicial de consumo de modelos.
- Para modelos GPT, se usara el endpoint `https://opencode.ai/zen/v1/responses`.
- La integracion debe quedar aislada detras de una interfaz de summarization para poder cambiar de proveedor sin tocar el core.

Variables de entorno propuestas:

```text
OPENCODE_API_KEY=...
OPENCODE_BASE_URL=https://opencode.ai/zen/v1/responses
OPENCODE_MODEL=gpt-5.4-nano
```

Modelos candidatos via OpenCode Zen:

- `gpt-5.4-nano`: candidato principal por coste para resumen, clasificacion, extraccion de ideas y JSON estructurado.
- `gpt-5.4-mini`: fallback manual para videos de alta importancia o cuando `nano` produzca resumenes pobres.

Estrategia de coste:

```text
Por video:
  1. transcript normalizado
  2. prompt compacto
  3. salida estructurada en JSON/Markdown
  4. guardar resultado
  5. no reprocesar salvo cambio de prompt o transcript
```

Riesgos:

- Los modelos baratos pueden perder matices, jerarquia o conexiones profundas.
- Transcripts largos pueden requerir chunking o prompts mas compactos.
- El output largo cuesta mas que el input en modelos baratos; conviene limitar formato.
- Hay que evaluar calidad con videos reales antes de decidir.
- OpenCode Zen agrega una dependencia de proveedor; el core debe depender de una interfaz propia, no de llamadas OpenCode repartidas por el codigo.

Interfaz inicial:

```text
Summarizer.generateDigest(transcript, options) -> DigestDraft
```

Adapter inicial:

```text
OpenCodeSummarizer
```

La razon para introducir esta interfaz desde el primer MVP es que el **Summarizer** es un seam real: es probable comparar OpenCode Zen, OpenAI directo, Anthropic, Gemini u otros endpoints. El dominio debe depender de la capacidad de generar un **Digest**, no del proveedor concreto.

El adapter OpenCode debe solicitar salida estructurada con `text.format: json_schema`. Sin schema, `gpt-5.4-nano` puede devolver JSON valido pero con campos incompatibles, por ejemplo `tldr` como string, `relevantTimestamps` como strings o `verdict` como frase libre.

## Core Service Boundary

La pieza valiosa del sistema debe ser un servicio propio, no un workflow no-code donde quede enterrada la logica.

```text
video-digest-service
  core/
    getPlaylistVideos()
    getTranscript()
    scoreTranscriptQuality()
    summarizeVideo()
    sendEmail()
    saveDigest()
  interfaces/
    HTTP API
    CLI
    cron worker
    mini frontend
    n8n webhook adapter
```

Ventajas:

- La logica se prueba una vez y se consume desde varias interfaces.
- n8n puede cambiarse por otro trigger sin perder el producto.
- Permite empezar local con CLI y luego desplegar API/frontend.
- Facilita evolucionar hacia una knowledge base personal.
- Permite benchmarkear proveedores de transcript sin reescribir workflows.

## Runtime and Language

MVP 001 usara TypeScript sobre Bun para el CLI, tests y desarrollo local.

```text
Language: TypeScript
Runtime: Bun 1.3.14
Test runner: bun test
Initial interface: CLI
```

La razon es optimizar velocidad de desarrollo local, ejecucion directa de TypeScript y tests rapidos.

El core debe mantenerse razonablemente portable: la logica de dominio no debe depender de APIs exclusivas de Bun. Las dependencias especificas de runtime, como filesystem, subprocesses o detalles HTTP, deben vivir en adapters o en la capa CLI.

Riesgo aceptado: un despliegue futuro en Vercel podria requerir adaptar runtime o separar la API en Node/Next. Ese trade-off se pospone porque MVP 001 es local-first.

CLI de MVP 001:

```text
bun run video-digest <youtube-url> [--email-preview]
```

No se optimizara para `npx` en MVP 001. Para soportar `npx` en el futuro habria que publicar un paquete compatible con Node o mantener un entrypoint portable. La decision actual es mantener el core portable y aceptar que la interfaz inicial depende de Bun.

## Configuration and Secrets

MVP 001 usara `.env` local para secrets y `.env.example` versionado para documentar configuracion.

```text
OPENCODE_API_KEY=
OPENCODE_BASE_URL=https://opencode.ai/zen/v1/responses
OPENCODE_MODEL=gpt-5.4-nano
VIDEO_DIGEST_OUTPUT_DIR=outputs
```

Bun carga `.env` automaticamente, asi que no se usara `dotenv`.

Reglas:

- `.env` no se commitea.
- `.env.example` se commitea con valores seguros.
- Si falta `OPENCODE_API_KEY`, el CLI debe fallar con error claro antes de llamar al LLM.
- Secrets no deben guardarse en metadata ni outputs.

## Python Sidecar

`youtube-transcript-api` es una libreria Python. MVP 001 mantendra el producto principal en Bun/TypeScript y usara un sidecar Python solo como adapter de **Transcript Source**.

```text
TranscriptSource
  -> PythonYoutubeTranscriptSource
     -> uv run python/fetch_transcript.py <video-id>
```

El entorno Python se gestionara con `uv` para evitar dependencias globales y hacer reproducible la instalacion de `youtube-transcript-api`.

Decision actual:

- `uv` instalado localmente en `~/.local/bin/uv`.
- Version comprobada: `uv 0.11.17`.
- Si la shell no encuentra `uv`, cargar `~/.local/bin/env` o usar la ruta absoluta.

Riesgo aceptado: el MVP cruza runtime Bun -> Python. Esta complejidad queda aislada en el adapter y no debe filtrarse al core.

## Trigger Options

### Option 1: n8n as orchestrator

n8n puede detectar o programar ejecuciones y llamar al servicio propio.

Uso recomendado:

```text
n8n Cron / manual trigger
-> POST /api/poll-playlist
-> servicio propio procesa nuevos videos
```

No se recomienda poner la logica principal de transcript/resumen dentro de n8n. n8n debe responder a "cuando ocurre", no a "como entendemos el video".

### Option 2: Vercel Cron

Vercel puede alojar una API/mini frontend y ejecutar un cron diario en plan Hobby.

Limitacion importante:

- Vercel Hobby permite cron diario, no polling frecuente.

Uso recomendado:

```text
Digest diario:
  revisar playlist Resumir
  procesar nuevos videos
  enviar email
```

No es ideal para near-real-time.

### Option 3: External scheduler

Un scheduler externo puede llamar a un endpoint del servicio:

```text
cron-job.org / GitHub Actions / Cloudflare Cron / VPS
-> POST /api/poll-playlist
```

Uso recomendado si se quiere polling cada 15-60 minutos sin pagar Vercel Pro.

### Option 4: CLI local

Primera interfaz recomendada para desarrollo:

```text
video-digest ingest https://youtube.com/watch?v=...
video-digest poll-playlist
```

Permite probar la logica sin desplegar.

### Option 5: Mini frontend

Interfaz futura:

```text
Pegar URL
-> ver transcript source y quality score
-> generar digest
-> enviar email
-> guardar nota
```

Util para uso manual y debugging.

## Activation Interfaces

### Interface 1: Manual assisted

Usuario pega una URL en Codex:

```text
Resume este video y enviamelo por email.
```

Codex usa Navegador, extrae transcript si existe, resume y envia email.

Uso:

- exploracion;
- videos puntuales;
- debugging;
- refinar plantilla.

No recomendado para produccion estable.

### Interface 2: Playlist trigger via polling

Usuario agrega video a playlist `Resumir`.

Un job automatico detecta videos nuevos.

Uso:

- flujo principal recomendado;
- n8n o script propio;
- buen balance entre automatizacion y control.

### Interface 3: Batch digest

Usuario procesa todos los videos acumulados en una playlist.

Uso:

- digest diario/semanal;
- limpieza de backlog;
- resumen comparativo entre videos.

### Interface 4: Knowledge base ingestion

Despues del email, el digest se guarda como nota.

Destinos posibles:

- Markdown local;
- Obsidian;
- Notion;
- Google Drive;
- Readwise Reader;
- base de datos propia.

## Digest Template v0

```text
# Digest de video

Titulo:
Canal:
Duracion:
URL:
Fuente del transcript:
Calidad estimada:

## TL;DR
5-7 lineas.

## Ideas clave
10 bullets.

## Timestamps relevantes
Fragmentos que merecen revision.

## Ideas accionables para mi
3-5 acciones.

## Conceptos para investigar
Lista corta.

## Conexiones
Relacion con otros videos, libros, proyectos o ideas.

## Veredicto
Ver completo / ver fragmentos / guardar / descartar.
```

## Open Questions

- Que herramienta de transcript falla menos con los videos reales de Miguel?
- Es suficiente un extractor no oficial o hace falta proveedor SaaS?
- Que umbral define "transcript malo"?
- Cuando activar fallback ASR/AI?
- Que modelo LLM barato es suficiente para resumen, extraccion de insights y clasificacion?
- Conviene usar un unico modelo barato o pipeline de dos pasos: modelo barato para extraccion y modelo mejor para sintesis ocasional?
- Donde guardar la knowledge base inicialmente: Markdown, Obsidian, Notion, Drive o Readwise?
- El email debe ser por video, diario o semanal?
- Debe haber un digest global que conecte multiples videos?
- Cuanto presupuesto mensual seria aceptable para SaaS/fallback AI?
- Como evitar guardar demasiado contenido protegido y conservar solo notas/resumenes propios?

## Next Steps

1. Crear playlist `Resumir` en YouTube.
2. Hacer benchmark con 5 videos reales:
   - `youtube-transcript-api`
   - `yt-dlp`
   - Supadata
   - TranscriptAPI.com
   - Apify actor
3. Medir:
   - disponibilidad de transcript;
   - calidad;
   - timestamps;
   - idioma;
   - latencia;
   - coste;
   - facilidad de integracion;
   - fallo esperado.
4. Elegir primera version del Transcript Service.
5. Crear MVP:
   - polling de playlist;
   - resumen;
   - email;
   - estado de videos procesados.
6. Guardar cada digest como Markdown para futura knowledge base.
7. Anadir fallback ASR/AI solo si el benchmark muestra que hace falta.

## Current Recommendation

Para empezar:

```text
Core propio reutilizable
+ CLI local como primera interfaz
+ YouTube Data API para playlist
+ youtube-transcript-api como primera capa
+ yt-dlp como fallback local
+ Supadata o Apify como fallback gestionado
+ modelo barato para digest inicial
+ Gmail para entrega
+ Markdown local para knowledge base inicial
```

Mantener Codex/Navegador como modo asistido para pruebas y refinamiento, no como worker automatico principal.

n8n se mantiene como opcion de trigger/orquestacion, no como centro de la arquitectura.

## MVP 001 Scope

El primer MVP debe demostrar la ingestion de un unico video desde una URL, sin automatizar todavia playlists ni despliegues.

```text
video-digest ingest <youtube-url>
  -> obtiene Transcript
  -> evalua Transcript Quality
  -> genera Digest
  -> guarda Digest como Markdown local y JSON sidecar
  -> opcionalmente genera email preview
```

Incluido:

- CLI local;
- procesamiento de un unico Video por URL;
- obtencion de Transcript con `youtube-transcript-api` como unica fuente inicial;
- evaluacion basica de Transcript Quality;
- generacion de Digest;
- guardado Markdown local para consumo humano;
- guardado JSON sidecar para consumo programatico;
- email preview como salida opcional.

Fuera de alcance:

- polling de Source Playlist;
- despliegue en Vercel;
- n8n;
- frontend;
- envio real de email;
- Knowledge Base avanzada;
- conexiones entre multiples videos;
- `yt-dlp` como fallback automatico;
- proveedores gestionados como Supadata, TranscriptAPI o Apify;
- fallback ASR/AI.

Razon: primero hay que validar que el core transforma un **Video** en un **Digest** util. Automatizar antes de validar esto solo aceleraria una experiencia incierta.

Si `youtube-transcript-api` no puede obtener el **Transcript**, el MVP debe devolver un error estructurado con la razon y una recomendacion de siguiente fallback, pero no debe intentar otro proveedor automaticamente.

El formato de salida queda versionado desde el primer MVP:

```text
outputs/transcripts/<video-id>.json
outputs/digests/<video-id>.md
outputs/metadata/<video-id>.json
```

El JSON debe incluir `schemaVersion: "digest.v0"` para permitir cambios futuros sin romper consumidores.

El Markdown es la interfaz humana inicial. El JSON es la interfaz programatica para futuros consumidores como frontend, email, Obsidian, Notion o analisis entre multiples videos.

MVP 001 guardara tambien el **Transcript** completo como **Transcript Artifact** local:

```text
outputs/transcripts/<video-id>.json
```

Este archivo existe para debugging, reproducibilidad y comparacion entre transcript y **Digest**. No debe tratarse como **Knowledge Item** ni exponerse como output principal.

La evaluacion de **Transcript Quality** sera determinista y versionada:

```text
qualitySchemaVersion: "transcript-quality.v0"
status: usable | warning | unusable
```

Campos iniciales:

```text
language
segmentCount
totalTextLength
durationSeconds
averageCharsPerMinute
warnings[]
```

Reglas iniciales:

- `unusable` si no hay segmentos, hay muy poco texto o faltan timestamps validos.
- `warning` si hay pocos segmentos, densidad de texto anomala, idioma inesperado, muchos segmentos vacios o repeticiones evidentes.
- `usable` si hay texto suficiente, segmentos y timestamps.

Umbrales iniciales de `transcript-quality.v0`:

```text
MIN_WARNING_TEXT_LENGTH = 250 characters
MIN_USABLE_TEXT_LENGTH = 1000 characters
MIN_USABLE_SEGMENT_COUNT = 20
MIN_AVERAGE_CHARS_PER_MINUTE = 250
```

Estas heuristicas son intencionalmente simples. Deben vivir detras de un evaluador versionado para poder refinar reglas o sustituirlas por otra estrategia sin romper consumidores de metadata.

Comportamiento segun calidad:

```text
usable
  -> generar Digest normalmente
  -> exit 0

warning
  -> generar Digest
  -> incluir warnings visibles en Markdown y JSON
  -> exit 0

unusable
  -> no llamar al LLM
  -> guardar metadata con error estructurado
  -> no generar Digest ni email preview
  -> exit 2
```

La razon es controlar coste y evitar resumenes falsamente autoritativos cuando el **Transcript** no es suficiente.

MVP 001 no usara YouTube Data API para obtener metadata factual del **Video**.

Metadata inicial:

```text
videoId: parsed from URL
url: canonicalized YouTube URL
videoTitle: null
channel: null
durationSeconds: derived from transcript timestamps when possible
```

El **Summarizer** generara un **Digest Title**. Este titulo describe el **Digest** y no debe confundirse con el titulo factual del **Video**.

Ejemplo:

```text
videoTitle: null
digestTitle: "Como Strauss Zelnick construye negocios en la interseccion de tecnologia y entretenimiento"
```

La razon es evitar mezclar metadata factual con contenido inferido por el modelo.

MVP 001 no enviara email real. Generara un email preview si el usuario lo pide:

```text
outputs/emails/<video-id>.md
```

La razon es evitar que Gmail OAuth, SMTP, credenciales, rate limits y errores de entrega distraigan del objetivo central: validar que un **Video** se convierte en un **Digest** util.
