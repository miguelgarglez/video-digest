# PRD: MVP 003 - Web Ingestion Feedback

Status: ready-for-agent  
Category: enhancement

## Contexto

El MVP web actual permite pegar una URL de YouTube, ejecutar la Ingestion completa y
ver el Digest resultante. El problema principal de UX es que `POST /ingestions`
bloquea hasta completar transcript, calidad, digest y escritura de artifacts. Durante
ese tiempo el navegador no ofrece feedback y la app parece colgada.

El core ya emite eventos de progreso mediante `ingestVideo.onProgress`, con etapas
como `fetching-transcript`, `scoring-transcript`, `generating-digest` y
`writing-outputs`. La web todavia no usa esos eventos.

## Decision

El siguiente slice sera una web progresiva server-rendered con polling persistido en
SQLite.

No migraremos todavia a React, Next.js ni otra libreria de front-end. La decision es
deliberada: antes de introducir un framework, el producto necesita demostrar que el
flujo basico de Ingestion bajo demanda se entiende, da feedback y deja un historial
fiable.

No se creara ADR para esta decision de MVP. El uso de polling, SQLite y una promesa
background in-process es una decision operacional barata de revertir y queda
documentada en este PRD. Una ADR sera apropiada si mas adelante se adopta una cola
durable, se separa web/worker, se migra a un framework front-end o se cambia el
almacenamiento principal.

## Objetivos

- Hacer que la creacion de una Ingestion responda rapido.
- Mostrar un estado `processing` mientras el pipeline esta trabajando.
- Persistir la etapa de progreso visible para que un refresh conserve contexto.
- Marcar Ingestions `processing` antiguas como `failed` al arrancar si el proceso se
  interrumpio antes de terminar.
- Reutilizar los eventos de progreso del core sin acoplarlo a la web.
- Mantener el deploy como un unico proceso Bun para el MVP.

## Fuera de alcance

- Cola durable real.
- Multiples workers o ejecucion multi-instancia.
- Server-Sent Events o WebSockets.
- Autenticacion.
- Playlist polling.
- Migracion a framework front-end.
- Render visual avanzado del Digest. Puede venir en un slice posterior.

## Flujo Propuesto

### Inicio de Ingestion

`POST /ingestions` validara la URL y parseara el `videoId`. Si la URL no es valida,
devolvera una pagina HTML de error en lugar de texto plano.

Si la URL es valida, el handler guardara o actualizara un registro SQLite con:

- `status = "processing"`
- `progressStage = "queued"` como etapa web inicial antes del primer evento del core
- `canonicalUrl`
- `videoId`
- timestamps actualizados

Despues lanzara la Ingestion en background dentro del proceso Bun y redirigira
inmediatamente a `/ingestions/:videoId` con status HTTP 303.

### Ejecucion en Background

La ejecucion seguira usando `runIngestionFromUrl(...)`, pero este servicio aceptara un
callback o dependencia para guardar progreso. Internamente pasara `onProgress` a
`ingestVideo`.

Cada evento del core actualizara el registro:

- `fetching-transcript`
- `scoring-transcript`
- `generating-digest`
- `writing-outputs`
- `completed`
- `unusable-transcript`

Cuando la ejecucion termine, el registro pasara a uno de los estados finales
existentes:

- `completed`
- `unusable-transcript`
- `transcript-unavailable`
- `failed`

El estado final seguira incluyendo paths, titulo del Digest, warnings, error code y
error message cuando correspondan.

### Pagina de Detalle

`GET /ingestions/:videoId` renderizara la misma pagina de detalle tanto para estados
intermedios como finales.

Si `status = "processing"`, la pagina mostrara:

- titulo provisional de Ingestion;
- URL canonica;
- badge de estado;
- etapa actual en lenguaje humano;
- indicador visual discreto de actividad;
- JavaScript minimo para polling.

La pagina consultara `GET /api/ingestions/:videoId` cada 1-2 segundos. Cuando la API
devuelva un estado final, la pagina podra recargarse para renderizar el resultado
server-side completo.

### API de Polling

`GET /api/ingestions/:videoId` devolvera JSON suficiente para que la UI no tenga que
conocer detalles internos:

```json
{
  "videoId": "1ZgUcrR0K7I",
  "canonicalUrl": "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  "status": "processing",
  "progressStage": "generating-digest",
  "statusLabel": "Procesando",
  "progressLabel": "Generando digest",
  "digestTitle": null,
  "errorMessage": null,
  "updatedAt": "2026-06-10T18:00:00.000Z"
}
```

Los labels se generaran en la capa web para mantener el modelo persistido tecnico y
la UI en espanol.

## Cambios de Modelo

`IngestionRecordStatus` incorporara `processing`.

`IngestionRecord` incorporara `progressStage`, nullable para registros historicos o
fallos antiguos. El tipo de `progressStage` aceptara `queued` ademas de las etapas que
ya emite `ingestVideo.onProgress`. Este campo es operacional y no se anadira a
`CONTEXT.md`: el core emite progreso tecnico, storage guarda progreso observable y la
web traduce ese progreso a copy en espanol.

`IngestionRepository` expondra operaciones explicitas para:

- crear o actualizar un registro `processing`;
- actualizar `progressStage`;
- guardar el resultado final.

Esto evita que el handler escriba SQL o conozca detalles de persistencia.

## Consideraciones de Concurrencia

Para el MVP, el trabajo background sera una promesa en memoria iniciada por el proceso
Bun. Esto es suficiente para ejecucion local y un unico contenedor.

Riesgo aceptado: si el proceso muere durante una Ingestion, el registro puede quedar en
`processing` hasta el siguiente arranque.

Mitigacion en MVP 003: al arrancar, marcar registros `processing` antiguos como
`failed` con un error operacional que explique que la Ingestion se interrumpio por
reinicio del servidor. No se reintentara automaticamente.

Mitigacion posterior: introducir una cola durable cuando el producto lo necesite.

## Testing

La implementacion debe cubrir:

- Repository: persiste `processing` y `progressStage`.
- Handler: `POST /ingestions` redirige rapido tras crear el registro.
- Handler: la pagina de detalle incluye polling cuando el estado es `processing`.
- API: devuelve `status`, `progressStage` y labels para polling.
- Service: propaga eventos `onProgress` hacia el repository.
- Startup: marca Ingestions `processing` previas como `failed` sin reintentarlas.
- Regression: los estados finales actuales siguen renderizando correctamente.

## Criterio de Aceptacion

Al pegar una URL y enviar el formulario, el navegador debe navegar rapidamente a una
pagina de detalle. Esa pagina debe mostrar que la Ingestion esta en curso y actualizar
la etapa visible hasta que el Digest, error o skip final este disponible.

No debe instalarse ninguna dependencia nueva para este slice.
