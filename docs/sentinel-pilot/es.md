# Sentinel: despliegue y dominio

**Resultado:** dominio, DNS, HTTPS y API verificados; cargo al repetir: 0 USD.
Sitio: [sentinelproof.click](https://sentinelproof.click/).
El informe de la aplicación tiene la limitación de ATLAS descrita abajo.

## Alcance

La fábrica ya había creado Sentinel y lo había desplegado en Vercel.
Este piloto vuelve a desplegar esa versión, registra `sentinelproof.click` en
la cuenta del propietario en Porkbun y lo conecta al proyecto existente.
Porkbun proporciona el dominio y DNS; Vercel aloja la aplicación.
No es una prueba de creación de una aplicación desde cero.

## Presupuesto y acceso

Se autorizó una sola inscripción de un año, con un máximo de 3 USD.
El cargo real fue de 1,54 USD: el saldo pasó de 10 a 8,46 USD.
La renovación automática está desactivada. La renovación cotizada era de
10,81 USD; se debe consultar de nuevo antes de renovarlo.
Se utilizan los contactos existentes de la cuenta y privacidad WHOIS.
El propietario debe completar cualquier verificación de correo requerida.

Las claves de producción se leen de
`~/.config/domain-kit/porkbun/production/api-key` y `secret-key`, con permisos
`0600`. El token de Vercel permanece en el servidor de la fábrica; se utiliza
mediante SSH, sin copiarlo al equipo. No se escribe en GitHub.

## Ejecución desde aicom

```bash
node domain-kit/scripts/sentinel-live-pilot.mjs preflight
node domain-kit/scripts/sentinel-live-pilot.mjs deploy
node domain-kit/scripts/sentinel-live-pilot.mjs run
```

`preflight` valida la primera compra sin cobrar. Después de comprar, el nombre
deja de estar disponible. `deploy` crea un único despliegue y después consulta
su estado. Si sigue compilando, esperar y repetir.
`run` permite comprar únicamente después de comprobar el sitio y `/api/health`.
Al repetir `run`, se reutilizan el recibo y el despliegue: no se compra de nuevo.
El código de salida `2` indica que DNS o HTTPS aún están pendientes.

Tras configurar DNS, el proceso espera automáticamente: pausa de 20 segundos
entre intentos y ventana de espera de 10 minutos. Una petición ya iniciada
termina según su propio tiempo límite. Los estados distinguen DNS, certificado,
HTTPS, aplicación y proveedor. `ready` exige todas las comprobaciones correctas,
incluidas la API y la base de datos. El progreso se guarda en
`data/sentinel-live/setup-status.json`. Si se agota el plazo, permanece pendiente
y sale con código `2`. Para continuar sin pasar por la compra:
`node domain-kit/scripts/sentinel-live-pilot.mjs verify`.
No hay consultas en segundo plano tras terminar el proceso; hace falta otra
ejecución o un planificador externo. Los errores de acceso requieren atención.

## Recuperación y aceptación

El estado cifrado está en `domain-kit/data/sentinel-live/`, excluido de Git.
No borrarlo para reintentar. Si se pierde una respuesta, se reutiliza la misma
clave de operación. Después de 23 horas, un resultado incierto requiere
comprobación manual. `pilot.lock` impide ejecuciones simultáneas; antes de
eliminarlo tras un fallo, comprobar que el proceso indicado terminó.

El éxito exige verificación del dominio y DNS en Vercel, HTTPS operativo,
health-check correcto y ningún cambio de saldo en la segunda ejecución.
La generación del informe de seguridad en el navegador se comprueba por
separado: un dominio operativo no demuestra que funcionen las fuentes externas.

Este piloto está limitado a la cuenta del propietario, un dominio y un proyecto.
El adaptador de proveedores en modo sandbox no se modifica.

## Limitación observada

La prueba de Berlín en la dirección original de Vercel y en el nuevo dominio devolvió `UNKNOWN`:
la capacidad de pago de ATLAS `atlas.situation.brief@v1` no estaba disponible
en el modo gratuito actual. No se realizó ningún pago adicional a ATLAS.
Es una limitación de la aplicación, independiente de la inscripción y del DNS.
