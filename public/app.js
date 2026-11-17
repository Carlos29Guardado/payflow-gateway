// El frontend: habla con la API de PayFlow usando fetch.

const FINALES = new Set(["capturado", "fallido", "rechazado", "en_revision"]);
const pagos = new Map(); // id -> último estado conocido
const form = document.querySelector("#form-pago");
const mensaje = document.querySelector("#mensaje");
const cuerpoTabla = document.querySelector("#pagos");

function avisar(texto, esError = false) {
  mensaje.textContent = texto;
  mensaje.classList.toggle("error", esError);
}

// El usuario escribe dólares (15.50); la API pide centavos enteros (1550).
function leerFormulario() {
  const monto = Math.round(Number(document.querySelector("#monto").value) * 100);
  const moneda = document.querySelector("#moneda").value.toUpperCase();
  const descripcion = document.querySelector("#descripcion").value.trim();
  return { monto, moneda, ...(descripcion && { descripcion }) };
}

async function enviarPago(datos, clave) {
  const cabeceras = { "Content-Type": "application/json" };
  if (clave) cabeceras["Idempotency-Key"] = clave;

  const respuesta = await fetch("/payments", {
    method: "POST",
    headers: cabeceras,
    body: JSON.stringify(datos),
  });
  const cuerpo = await respuesta.json();
  if (!respuesta.ok) throw new Error(cuerpo.error ?? "Error desconocido");
  return { pago: cuerpo, repetido: respuesta.headers.get("Idempotent-Replayed") === "true" };
}

function dinero({ monto, moneda }) {
  return new Intl.NumberFormat("es", { style: "currency", currency: moneda }).format(monto / 100);
}

function celda(texto, clase) {
  const td = document.createElement("td");
  td.textContent = texto; // textContent (no innerHTML): lo que escribe el usuario nunca se ejecuta
  if (clase) td.className = clase;
  return td;
}

function pintar() {
  cuerpoTabla.replaceChildren();
  for (const pago of [...pagos.values()].reverse()) {
    const fila = document.createElement("tr");
    const estado = document.createElement("td");
    const etiqueta = document.createElement("span");
    etiqueta.className = `estado ${pago.estado}`;
    etiqueta.textContent = pago.estado;
    estado.append(etiqueta);

    fila.append(
      celda(pago.id.slice(0, 12) + "…", "id"),
      celda(dinero(pago)),
      estado,
      celda(pago.intentos),
      celda(pago.error ?? pago.descripcion ?? ""),
    );
    cuerpoTabla.append(fila);
  }
  document.querySelector("#tabla").hidden = pagos.size === 0;
  document.querySelector("#vacio").hidden = pagos.size > 0;
}

// Consulta el pago cada rato hasta que llegue a un estado final.
async function seguir(id) {
  while (!FINALES.has(pagos.get(id).estado)) {
    await new Promise((ok) => setTimeout(ok, 500));
    try {
      const respuesta = await fetch(`/payments/${id}`);
      if (respuesta.ok) pagos.set(id, await respuesta.json());
    } catch {
      // sin red por un momento: reintentamos en la siguiente vuelta
    }
    pintar();
  }
}

function registrar(pago) {
  const nuevo = !pagos.has(pago.id);
  pagos.set(pago.id, pago);
  pintar();
  if (nuevo) seguir(pago.id);
}

async function manejar(accion) {
  const botones = form.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  try {
    await accion();
  } catch (error) {
    avisar(error.message, true);
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

form.addEventListener("submit", (evento) => {
  evento.preventDefault();
  manejar(async () => {
    const { pago } = await enviarPago(leerFormulario(), crypto.randomUUID());
    registrar(pago);
    avisar("Pago aceptado: se está procesando.");
  });
});

// Demo de idempotencia: dos peticiones idénticas, un solo cobro.
document.querySelector("#btn-doble").addEventListener("click", () => {
  if (!form.reportValidity()) return;
  manejar(async () => {
    const datos = leerFormulario();
    const clave = crypto.randomUUID();
    const primera = await enviarPago(datos, clave);
    const segunda = await enviarPago(datos, clave);
    registrar(primera.pago);
    avisar(
      segunda.repetido && segunda.pago.id === primera.pago.id
        ? "Se enviaron 2 peticiones con la misma clave: se creó un solo pago."
        : "Ojo: la segunda petición creó otro pago.",
    );
  });
});
