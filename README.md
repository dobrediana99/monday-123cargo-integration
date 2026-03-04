# Monday.com ↔ 123cargo Integration

Integrare automată între Monday.com și 123cargo (bursaTransport) cu validări stricte și reguli de business.

## Comportament

### Trigger
Automatizarea pornește doar când statusul unui item din Monday se schimbă în **"De publicat pe bursa"**.

### Flux de Procesare

1. **Validare Reguli de Business** (OBLIGATORIU PRIMUL)
   - Mod Transport Principal trebuie să fie doar "Rutier / Road" sau "Alege!"
   - Tip Marfa NU poate fi "Deșeuri / Waste"

2. **Validare Date în Monday**
   - Verifică că toate coloanele obligatorii sunt completate corect
   - Dacă validarea eșuează → mesaj de eroare + status eroare

3. **Autentificare 123cargo**
   - Se alege utilizatorul pentru 123cargo în ordinea:
     1. **Principal** (`deal_owner`) - PRIORITATE
     2. **Preluat de** (`multiple_person_mkybbcca`) - FALLBACK
   - Mapping între Monday userId și credențiale 123cargo (Basic Auth)

4. **Mapping Tip Mijloc Transport**
   - Mapare strictă între valorile din Monday și opțiunile 123cargo
   - Dacă nu există corespondent valid → eroare

5. **Trimitere Request către 123cargo**
   - Doar dacă toate validările sunt OK
   - POST către `/loads` cu toate datele

6. **Rezultat**
   - **Succes**: Status → "Publicat", coloana eroare se golește
   - **Eșec**: Mesaj eroare + status eroare

## Coloane Monday Utilizate

### Obligatorii

| Column ID | Title | Type | Validare |
|-----------|-------|------|----------|
| `deal_owner` | Principal | people | Trebuie completat (SAU `multiple_person_mkybbcca`) |
| `multiple_person_mkybbcca` | Preluat de | people | Fallback dacă `deal_owner` nu e completat |
| `numeric_mkr4e4qc` | Buget Client | numbers | Număr > 0 |
| `color_mksh2abx` | Moneda | status | Obligatoriu (RON/EUR/USD) |
| `dropdown_mkx6jyjf` | Tara Incarcare | dropdown | Obligatoriu |
| `text_mkypcczr` | Localitate Incarcare | text | Obligatoriu |
| `dropdown_mkx687jv` | Tara Descarcare | dropdown | Obligatoriu |
| `text_mkypxb8h` | Localitate Descarcare | text | Obligatoriu |
| `text_mkt9nr81` | Greutate (KG) | text | Număr > 0 |
| `date_mkx77z0m` | Data Inc. | date | Obligatoriu |
| `numeric_mkypzwfe` | Nr. zile valabile Incarcare | numbers | Număr > 0 |
| `dropdown_mkx1s5nv` | Tip Mijloc Transport | dropdown | Obligatoriu + mapping valid |

### Reguli de Business

| Column ID | Title | Type | Regulă |
|-----------|-------|------|--------|
| `color_mkx12a19` | Mod Transport Principal | status | Doar "Rutier / Road" sau "Alege!" |
| `dropdown_mkx1s5nv` | Tip Marfa | dropdown | NU poate fi "Deșeuri / Waste" |

## Mapping Tip Mijloc Transport

Valorile din Monday (RO) → 123cargo API:

| Monday (RO) | 123cargo Code | 123cargo Name |
|-------------|---------------|---------------|
| Duba | 1 | Box |
| Prelata | 2 | Tilt |
| Platforma | 3 | Flat |
| Basculanta | 5 | Tipper |
| Cisterna | 6 | Tank |
| Container | 7 | Container |
| Cisterna alimentara | 8 | Liquid food container |
| Agabaritic | 9 | Oversized |
| Transport autoturisme | 10 | Car transporter |
| Cap tractor | ❌ | Nu există corespondent |

**Notă**: Dacă în Monday apare "Cap tractor" → EROARE (nu există în 123cargo).

## Configurare

### Variabile de Mediu (.env)

```env
PORT=3000

# Monday
MONDAY_TOKEN=your_monday_token_here

# 123cargo
BURSA_BASE=https://www.bursatransport.com/api

# Monday Column IDs
DEAL_OWNER_COLUMN_ID=deal_owner
ERROR_COLUMN_ID=text_mkyp9v8d
TRIGGER_STATUS_SUCCESS_LABEL=Publicata
TRIGGER_STATUS_ERROR_LABEL=Eroare
TRIGGER_STATUS_ONLY_LABEL=De publicat pe bursa
DEFAULT_LOADING_INTERVAL_DAYS=1

# Optional test mode (ignora Principal/Preluat de pentru autentificare)
FORCE_TEST_AUTH_MODE=0
TEST_BURSA_USERNAME=
TEST_BURSA_PASSWORD=
```

### User Mapping (în cod)

În `src/index.ts`, secțiunea `USER_MAP`:

```typescript
const USER_MAP: Record<number, { basicB64: string }> = {
  96280246: { basicB64: "cmFmYWVsLm9AY3J5c3RhbC1sb2dpc3RpY3Mtc2VydmljZXMuY29tOlRyYW5zcG9ydC4yMDI0" }
  // Adaugă mai mulți utilizatori aici
  // userId: { basicB64: base64("username:password") }
};
```

Pentru a adăuga un nou utilizator:
1. Obține Monday `userId` din coloana People
2. Generează Basic Auth: `echo -n "username:password" | base64`
3. Adaugă în `USER_MAP`

### Mod test (override autentificare)

Pentru test rapid, poți forța aplicația să posteze pe un singur cont Bursa (indiferent de `Principal` / `Preluat de`):

```env
FORCE_TEST_AUTH_MODE=1
TEST_BURSA_USERNAME=utilizator@firma.com
TEST_BURSA_PASSWORD=parola
```

În acest mod:
- autentificarea nu mai folosește `USER_MAP`
- validarea pentru people columns este sărită
- restul validărilor/mapping-urilor rămân active

### Fallback pentru `Nr. zile valabile Incarcare`

Dacă board-ul nu are coloana `numeric_mkypzwfe`, integrarea folosește automat:

```env
DEFAULT_LOADING_INTERVAL_DAYS=1
```

Poți schimba valoarea din env (număr > 0).

## Instalare și Rulare

### Instalare Dependențe

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Production

```bash
npm start
```

## Endpoint-uri

### Health Check

```
GET /health
```

Răspuns:
```json
{
  "ok": true
}
```

### Webhook Monday

```
POST /webhooks/monday
```

Primește webhook-uri de la Monday.com când se schimbă statusul unui item.

## Tipuri de Erori

Toate erorile sunt scrise în coloana de eroare din Monday cu un prefix:

- `[BUSINESS RULES]` - Încălcare reguli de business (Mod Transport, Tip Marfa)
- `[USER]` - Utilizator lipsă sau nemapat în 123cargo
- `[VALIDATION]` - Coloane obligatorii necompletate sau invalide
- `[MAPPING]` - Erori la maparea datelor către 123cargo (țări, transport, etc.)
- `[123CARGO]` - Eroare la trimiterea către API 123cargo

## Exemple de Erori

### Reguli de Business

```
[BUSINESS RULES] Modul de transport principal trebuie să fie «Rutier / Road» sau «Alege!», nu «Maritim»
```

```
[BUSINESS RULES] Tip Marfa nu poate fi «Deșeuri / Waste». Valoare curentă: «Deșeuri periculoase»
```

### Validare

```
[VALIDATION] Buget Client (numeric_mkr4e4qc) trebuie sa fie un numar > 0.; Greutate (KG) (text_mkt9nr81) trebuie sa fie un numar > 0.
```

### Mapping

```
[MAPPING] Tip Mijloc Transport 'Cap tractor' nu are corespondent valid în 123cargo.
```

### User

```
[USER] Trebuie completat fie 'Principal' (deal_owner), fie 'Preluat de' (multiple_person_mkybbcca).
```

## Caracteristici Tehnice

- **Deterministă**: Fără presupuneri, toate regulile sunt explicite
- **Validări stricte**: Orice abatere produce eroare clară
- **Mapping explicit**: Toate conversiile sunt documentate și ușor de extins
- **Gestionare erori**: Mesaje clare pentru debugging
- **Retry-safe**: Răspunde 200 pentru a evita retry loop-uri în Monday

## Extindere

### Adăugare Tip Mijloc Transport Nou

În `src/index.ts`, secțiunea `UI_RO_TO_123CARGO_TRUCKTYPE`:

```typescript
const UI_RO_TO_123CARGO_TRUCKTYPE: Record<string, { code: number; apiName: string } | null> = {
  // ... existent
  "nou tip": { code: 11, apiName: "New Type" },
  // sau pentru tipuri fără corespondent:
  "tip fara mapping": null
};
```

### Adăugare Validare Nouă

În `src/index.ts`, funcția `validateBusinessRules` sau `validateRequired`:

```typescript
// Exemplu validare nouă
const nouaCampValidare = (cols["id_coloana"]?.text ?? "").trim();
if (!nouaCampValidare) {
  errors.push("Noua campă este obligatorie.");
}
```

## Licență

Proprietate privată - Crystal Logistics Services
