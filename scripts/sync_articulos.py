"""Copia el maestro de artículos de 611 (réplica BI de Gescom) a la tabla `articulos` de Supabase.

Lo usa el buscador de Roturas. Corre todos los días con GitHub Actions (.github/workflows/articulos.yml);
en local toma la clave de .secrets/api-keys.json y la contraseña de la BI de pgpass.conf.

Entran los artículos activos y los inactivos que todavía tienen stock (se puede romper algo discontinuado).
Los que dejan de cumplir eso quedan con activo = false (no se borran: puede haber roturas cargadas).
"""
import json
import os
import urllib.request
from datetime import datetime, timezone

import psycopg2

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://wuwehtxbqunocwyziptw.supabase.co")
EMPRESA = "611"


def clave_servicio():
    if os.environ.get("SUPABASE_SERVICE_KEY"):
        return os.environ["SUPABASE_SERVICE_KEY"]
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".secrets", "api-keys.json")
    return next(k["api_key"] for k in json.load(open(ruta)) if k["name"] == "service_role")


def leer_gescom():
    cur = psycopg2.connect(
        host=os.environ.get("PGHOST", "bi.data.gescom.online"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "gcwbi"),
        user=os.environ.get("PGUSER", "gcw-611logistica"),
        password=os.environ.get("PGPASSWORD") or None,  # sin variable, usa pgpass.conf
        connect_timeout=30,
    ).cursor()
    # Mismo criterio que Pedidos 611: sin proveedor "611" (adelantos, NC, varios), cartón ni material POP (1500...).
    cur.execute(
        """
        SELECT i.codigo, i.descripcion, i.prov_codigo, trim(i.prov_razonsocial)
        FROM item i
        WHERE i.prov_codigo IS NOT NULL AND i.prov_codigo <> '611'
          AND i.descripcion NOT ILIKE '%%carton%%'
          AND i.codigo NOT LIKE '1500%%'
          AND (i.activo = 1 OR EXISTS (SELECT 1 FROM stock s WHERE s.item_codigo = i.codigo AND s.cantidad > 0))
        """
    )
    ahora = datetime.now(timezone.utc).isoformat()
    return [
        {
            "empresa": EMPRESA,
            "codigo": cod.strip(),
            "descripcion": " ".join((desc or "").replace("\xa0", " ").split()),
            "prov_codigo": pcod,
            "proveedor": prs or pcod,
            "activo": True,
            "actualizado": ahora,
        }
        for cod, desc, pcod, prs in cur.fetchall()
    ]


def rest(metodo, ruta, cuerpo=None, prefer=None):
    k = clave_servicio()
    h = {"apikey": k, "Authorization": "Bearer " + k, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + ruta, method=metodo, headers=h,
                                 data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    with urllib.request.urlopen(req) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else None


def main():
    nuevos = leer_gescom()
    for i in range(0, len(nuevos), 500):
        rest("POST", "articulos?on_conflict=empresa,codigo", nuevos[i:i + 500],
             "resolution=merge-duplicates,return=minimal")
    vigentes = {a["codigo"] for a in nuevos}
    actuales = rest("GET", f"articulos?select=codigo&empresa=eq.{EMPRESA}&activo=eq.true&limit=10000")
    bajas = [a["codigo"] for a in actuales if a["codigo"] not in vigentes]
    for i in range(0, len(bajas), 100):
        lista = ",".join('"%s"' % c.replace('"', "") for c in bajas[i:i + 100])
        rest("PATCH", f"articulos?empresa=eq.{EMPRESA}&codigo=in.({lista})", {"activo": False}, "return=minimal")
    print(f"{len(nuevos)} artículos vigentes, {len(bajas)} dados de baja")


if __name__ == "__main__":
    main()
