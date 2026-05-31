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

Modelos candidatos:

- `gpt-5-nano`: candidato principal para resumen, clasificacion, extraccion de ideas y JSON estructurado de bajo coste.
- `gpt-5-mini`: fallback cuando `nano` produzca resumenes pobres o el video sea de alta importancia.
- `gpt-4.1-nano`: alternativa barata, con ventana de contexto grande y buen seguimiento de instrucciones, aunque la recomendacion actual para tareas mas complejas seria empezar por `gpt-5-nano`.

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
