# PayFlow

Pasarela de pagos simulada, orientada a eventos, con un agente LLM antifraude. Proyecto de portafolio hecho con Node.js puro (solo depende del SDK de Anthropic).

## Qué hace

- **API de pagos** con validación e **idempotencia** (`Idempotency-Key`): reintentar la misma petición no cobra dos veces.
- **Cola con reintentos** y espera creciente: el pago se acepta al instante (`202`) y se procesa después.
- **Agente antifraude (LLM)** que evalúa cada pago antes de llamar al banco.
- **Webhooks firmados** (HMAC-SHA256 con marca de tiempo) que avisan a las tiendas, con reintentos y lista de fallidos.
- **Frontend** mínimo para crear pagos y ver su estado.

## Flujo de un pago

```
POST /payments → 202 (creado)
      │
      ▼
   cola ──► agente antifraude ──┬─ aprobar ──► banco ──► capturado
                                ├─ revisar ──► en_revision
                                └─ rechazar ─► rechazado
      │
      ▼
 eventos ──► webhooks firmados ──► tienda
```

Estados: `creado → procesando → capturado | fallido | rechazado | en_revision`.
Eventos de webhook: `pago.capturado`, `pago.fallido`, `pago.rechazado`, `pago.en_revision`.

## Cómo correrlo

Requiere Node 20 o superior.

```bash
npm install
npm start        # http://localhost:3000
npm test         # 31 pruebas, sin red y sin costo
```

### Agente antifraude: dos modos

| Modo | Cuándo | Qué usa |
|---|---|---|
| Claude | Si existe `ANTHROPIC_API_KEY` | API de Anthropic (modelo `claude-opus-5-5`, cambiable con `ANTHROPIC_MODEL`) |
| Simulado | Si no hay clave | Reglas fijas locales, sin red ni costo |

```bash
# PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/payments` | Crea un pago. Cuerpo: `{ "monto": 1050, "moneda": "USD", "descripcion": "..." }`. El monto va en centavos. |
| GET | `/payments/:id` | Consulta un pago (incluye el veredicto en `fraude`). |
| POST | `/webhooks` | Registra una URL. Devuelve un secreto una sola vez. |

Los avisos llevan la cabecera `PayFlow-Signature: t=<tiempo>,v1=<firma>`. La tienda recalcula `HMAC-SHA256(secreto, "<tiempo>.<cuerpo>")` y rechaza mensajes de más de 5 minutos.

## Decisiones de diseño

- **Responder rápido, procesar después:** el cliente no espera al banco ni a la IA.
- **Idempotencia** por clave: protege contra dobles cobros en reintentos.
- **Reintentos unificados:** banco, agente y webhooks usan la misma `Cola`. Si el banco falla después de un veredicto, no se vuelve a consultar a la IA.
- **Un id por evento:** los reintentos de webhook reenvían siempre el mismo evento, así la tienda detecta duplicados.
- **Fallos aislados:** si un webhook nunca se entrega, el pago no se ve afectado.
- **Seguridad del agente:** la descripción del pago es texto del cliente, así que va como dato, nunca en las instrucciones; la respuesta se fuerza a un esquema JSON y se valida; una negativa o una decisión inválida cuentan como fallo y se reintentan.
- **Inyección de dependencias:** banco y agente se pasan a `crearApp`, por eso las pruebas controlan cada fallo sin esperas ni llamadas externas.

## Limitaciones (es una demo)

- Datos **en memoria**: se pierden al reiniciar.
- **Sin autenticación** en la API.
- `POST /webhooks` acepta cualquier URL http(s), incluidas redes internas (riesgo SSRF).
- No hay límite de tamaño del cuerpo de las peticiones.
- El banco es simulado.
- Los pagos en `en_revision` no tienen aún un endpoint para aprobarlos o rechazarlos a mano.
- La llamada real a Claude no está cubierta por pruebas automáticas (las pruebas usan un cliente falso).

## Estructura

```
src/    app.js (API) · processor.js · fraud.js · queue.js · webhooks.js · signature.js · store.js · bank.js
public/ frontend
test/   pruebas con node:test
```

## Licencia

MIT
