# Gözlem sözleşmesi (A0)

Atahan, bu doküman indexer'ın motora ne vereceğini anlatıyor. Şema
`packages/schema` içinde, kod ve fixture'lar burada yazılanla birebir aynı;
ikisi ayrışırsa kod haklıdır ve bu dokümanı düzeltiriz. Bir saat içinde eşleyiciyi
yazmaya başlayabilmen için yazıldı, o yüzden sıra: önce nasıl kullanılır ve
16 Eylül'de ne bekleniyor, sonra alanlar, sonra şemanın **kontrol etmediği**
kurallar. O son bölüm en önemlisi; düzyazıda duran ve kimsenin zorlamadığı her
iddia bu projede yanlış çıktı, o yüzden zorlanmayan kural burada "zorlanmıyor"
diye açıkça yazılı.

## 1. Nereden başlıyorsun

Paket `@nonametrust/schema`, tek bağımlılığın bu. Kendi paketine şöyle bağla:

```json
"dependencies": { "@nonametrust/schema": "workspace:*" }
```

`main` alanı `dist/index.js`'e bakıyor ve `src`'ye düşen bir yol yok: `dist`
yoksa ya da eskiyse import ya patlar ya eski şemayı görür. O yüzden `pnpm build`
**ilk kurulumda ve `packages/schema`'ya dokunan her pull'dan sonra** koşulur;
kökteki sıra `pnpm build`, `pnpm typecheck`, `pnpm test` (CI de bu sırada).
Sonra:

```ts
import { validateObservation, deriveIdempotencyKey } from "@nonametrust/schema";
import type { WireObservation, VolumePayload, ProtocolPayload, ContentPayload } from "@nonametrust/schema";

const r = validateObservation(obj);      // obj: parse edilmiş JSON, string değil
if (!r.ok) console.error(r.errors);       // ["alan: mesaj", ...]
else out.write(JSON.stringify(r.value) + "\n");   // r.value.idempotencyKey atanmış geliyor
```

Eşleyicinin dönüş tipi **`WireObservation`**, `Observation` değil. `Observation`
depodaki biçim: motorun atadığı alanları da taşır. `WireObservation` telde
giden biçim: `observationId` ve `ingestedAt` tipte yok, yani onları yazarsan
`validateObservation`'ın reddetmesini beklemeden derleyici söyler.
`idempotencyKey` iki tipte de isteğe bağlı (bölüm 10).

Hatalar `alan: mesaj` biçiminde ve kontrol sırası şu: obje mi, motorun alanları
var mı, `schemaVersion` tam eşleşiyor mu, zarf, kanalın payload'ı, varsa
`idempotencyKey` türetilenle aynı mı. İlk düşen katmanda duruyor; yani önce
şekil hatalarını görürsün, anahtar en sonda.

Örnekler `packages/schema/fixtures/` altında, kanal başına bir dosya. Yedisi tek
hikâye: bir x402 veri sağlayıcısı, 20 Ağustos–12 Eylül 2026. Eşleyicinin
ürettiğini bu dosyalarla yan yana koy; alan adı ya da biçim farkı varsa büyük
ihtimalle senin taraf yanlış, ama fixture da yanlış olabilir, söyle.

Testler: repo kökünde `pnpm test`. Kendi paketini eklediğinde `pnpm -r test` onu
da koşar.

### Gözlemler nereye gidiyor

16 Eylül'de motor yok, dolayısıyla ingest de yok; brief'in dediği gibi
gözlemleri **diske yaz**. Biçim: newline-delimited JSON, her satırda
`validateObservation`'dan `ok: true` çıkmış **tek gözlem** (yani
`idempotencyKey` satırda var), her geri doldurma koşusu için **bir dosya**,
dosya adı kapsadığı aralığı söylüyor:

```
out/stellar-pubnet_2026-08-01_2026-08-31.ndjson
```

Yeniden koşma kabul testin bizim depoyu beklemiyor: aynı aralığı iki kez koş,
iki dosyanın her satırından `idempotencyKey`'i topla, iki küme **birebir aynı**
olmalı. Fazla bir anahtar varsa ya `ref` kararlı değil ya aynı olayı iki kez
üretiyorsun; eksik varsa bir okuma sessizce düştü. Bu test senin tarafında
yaşar ve 7. bölümdeki "tekilleştirme" sayısı onun çıktısıdır.

### 16 Eylül'de ne var, ne yok

Teslimde **üç kanal** var: `volume`, `content` (sadece memo) ve `protocol`.
Kabul ölçütlerin bunları ölçüyor: ödeme ailesi üzerinde kapsama, tekilleştirme,
sebebiyle düşen kayıt, muxed payı.

`cluster_proximity` **16 Eylül'de yok.** Bir küme listesi ve bir dust eşiği
gerekiyor, ikisi de ölçüm çalışmasından gelecek ve henüz vermediğimiz ayrı bir
karar. Onu kurma, onun için endişelenme; kanal şemada duruyor ki sonra
eklemek şema göçü olmasın.

## 2. Zarf: her gözlemde olan alanlar

| Alan | Tip | Kural |
|---|---|---|
| `schemaVersion` | string | Şimdilik `"0.1.0"`. Tam eşleşme; başka değer reddedilir. |
| `namespace` | `{ kind, id, muxedId?, continuity? }` | Gözlemin **kim hakkında** olduğu. Bölüm 7. |
| `channel` | enum | Yedi kanaldan biri. Bölüm 3. |
| `evidenceKind` | `"event"` \| `"state"` | Anlık olay mı, süren durum mu. Bölüm 4. |
| `kind` | string | Kaynakta ne oldu: `payment`, `memo`, `trustline_open`. Kanal değil. Serbest metin; bölüm 12. |
| `observedAt` | UTC zaman | Sadece event'te, zorunlu. |
| `validFrom`, `validUntil` | UTC zaman, `validUntil` null olabilir | Sadece state'te. `validUntil` yazılmazsa null sayılır, "hâlâ sürüyor" demek. `validUntil < validFrom` reddedilir. |
| `source` | obje | Bunu kim, nereden, ne zaman okudu. Bölüm 8. |
| `payload` | obje | Kanala özgü, zorunlu. Her zaman bir JSON objesi; **hiçbir zaman `null` ya da string değil**. Boş obje de geçmez: hiçbir kanal boş payload kabul etmiyor, her kanalın zorunlu alanları bölüm 3'te. |
| `salienceHints` | `{ amount?, latencyMs? }` | İsteğe bağlı. Payload'ın depoda şifreli durması planlanıyor (henüz yok; M1'in işi); önem hesabı payload'ı açmadan bu ipuçlarını okuyacak. `volume` yazıyorsan `amount`'ı, `latency` yazıyorsan `latencyMs`'i buraya da yaz. |
| `signature` | string \| null | İsteğe bağlı, v0'da doğrulanmıyor. Alan şimdiden var ki sonra açmak şema göçü olmasın. Yazma. |

Her obje **strict**: tanınmayan bir anahtar atılmaz, gözlem reddedilir. Bu bilinçli;
sessizce atılan alan sana "akıyor" der ama akmıyordur.

Zaman damgalarının hepsi ISO 8601 **UTC ve `Z` ile biter**:
`2026-09-01T08:00:05.000Z`. `+03:00` gibi bir ofset reddedilir, mesajı da bunu
söyler. Bu kural tek yerden geliyor (`utcDatetimeSchema`), o yüzden her zaman
alanı aynı cevabı verir.

Tutarlar ve fiyatlar **string**tir, sayı değil: JSON sayısı double, Stellar tutarı
yedi ondalık. Biçim `/^(0|[1-9]\d*)(\.\d+)?$/`: Horizon'un verdiği `"0.0000100"`
ve `"500"` geçer; işaret, üs, virgül, baştaki sıfır (`"007"`, `"00.5"`) ve `"1."`
geçmez. İşareti `direction` taşır.

## 3. Yedi kanal, ve hangisini kim üretiyor

İki üretici var ve bu ayrımı karıştırmak kolay:

- **`stellar-indexer`** (sen): zincirden görülen şeyler. `volume`, `protocol`,
  `content`'in **memo** çeşidi, ve sonra `cluster_proximity`.
- **`x402-gateway`**: 402 cevabının içinde olan şeyler, zincirde hiç görünmez.
  `latency`, `price`, `address_integrity`, ve `content`'in **error** ile
  **response** çeşitleri. Bunları sen üretmiyorsun; fixture'larda duruyorlar ki
  `producer`'ın sabit olmadığını ve `network`'ün isteğe bağlı olduğunu göresin.

| Kanal | Ne | Üretici | 16 Eylül | Payload | Fixture | Fixture'daki `kind` |
|---|---|---|---|---|---|---|
| `volume` | Değer hareketi | indexer | evet | `amount` string, `assetCode`, `direction: "in" \| "out"` | `volume.json` | `payment` |
| `protocol` | Protokol seviyesinde olgu: trustline, kabul edilen varlık, hesap bayrağı | indexer | evet | `event` zorunlu; `assetCode?`, `assetIssuer?`, `issuerKnown?: boolean` | `protocol.json` | `trustline_open` |
| `content` | Karşı tarafın ürettiği serbest metin | memo: indexer; error, response: gateway | evet (memo) | `text`, `field: "memo" \| "error" \| "response"` | `content.json` | `memo` |
| `cluster_proximity` | Bilinen bir operasyon kümesine graf yakınlığı | indexer | **hayır** | `clusterId`, `hops` pozitif tam sayı (doğrudan temas = 1), `amount?` string | `cluster_proximity.json` | `dust_received` |
| `latency` | Cevap süresi | gateway | – | `latencyMs: number ≥ 0` | `latency.json` | `response_received` |
| `price` | İstenen fiyat | gateway | – | `quoted` string, `unit` (`"USDC"`) | `price.json` | `price_quoted` |
| `address_integrity` | İlan edilen ödeme adresinin değişmesi | gateway | – | `previous` zorunlu, `current` zorunlu, `muxedId?` | `address_integrity.json` ve `day-twelve/` | `payment_address_changed` |

Bir zincir olayı birden fazla gözlem üretebilir, her gözlem tek kanal taşır.
`volume.json` ile `content.json` bilerek aynı operasyondur: aynı `source`, iki
kanal, iki farklı anahtar. Ödeme ve memosu böyle akar.

Payload tipleri adıyla export edilmiş: `VolumePayload` yazılı bir interface (yön
kuralı doc comment'inde); `ProtocolPayload`, `ContentPayload`,
`ClusterProximityPayload`, `AddressIntegrityPayload`, `LatencyPayload`,
`PricePayload` de var, hepsi `PayloadByChannel["protocol"]` gibi map üzerinden de
erişilir. Eşleyicinin dönüş tipini bunlardan seç, uydurma.

## 4. `event` mi `state` mi, ve bir state nasıl biter

Event bir anda oldu: ödeme, memo, adres değişimi. `observedAt` taşır, aralık
taşımaz. State bir süre boyunca geçerli: açık trustline. `validFrom` ve
`validUntil` taşır, an taşımaz. Şema iki yönde de sıkı; state'e `observedAt`,
event'e `validFrom` yazamazsın.

Neden bu kadar katı: ölçüm çalışmasında S3 sinyali tarihsiz bir durumdu.
Analiz onu her pencereye, yedi günlük olana bile, "isabet" diye yazdı; kontrol
kolunda ise hiç ölçülemedi. Fark tek yönlüydü ve manşeti üç puan şişirdi. Motor
bir state'i hiçbir zaman zaman hesabına sokmaz (`datedAt` state için null döner
ve bunun kapısı var). Sen de bir olguyu tarihlemek için `observedAt`'a
sıkıştırma; süren bir şeyse state'tir. Örnek `protocol.json`: trustline 20
Ağustos'ta açıldı, `validUntil: null`, hâlâ sürüyor.

**Bir state nasıl biter.** State'in `ref`'i onu kuran operasyondur ve aynı `ref`
bir daha gönderilemez (bölüm 9), yani aralığı kapatmak için state'i yeniden
yayınlamak yapı gereği imkânsız. Kural, 5. bölümdeki adres kuralıyla aynı
biçimde: **süren durum bir state, bitişi ayrı bir gözlem.** Bitiş aynı kanalda
bir **event**tir, kapatan operasyonun kendi `ref`'ini ve anını taşır; trustline
için `kind: "trustline_closed"`. State'i **hiçbir zaman yeniden yazmazsın**,
`validUntil`'i sen doldurmazsın. Motorun bu event'i görüp aralığı kendiliğinden
kapatması M1'in işi, senin değil.

## 5. `address_integrity`: bir gözlem, bir geçiş

Bir gözlem tam olarak bir geçiş kaydeder: `previous` → `current`. Geri dönüş ayrı
bir geçiştir, kendi `source.ref`'iyle ayrı bir gözlemdir. `reverted: true` gibi
bir bayrak yok ve kabul edilmez. Sebep: bir günde iki geçiş aradığımız anomalinin
kendisi; tek kayda bayrak koymak o çifti gizler. `previous` zorunlu; önceki
adresi olmayan şey değişim değil ilk görüştür, buraya girmez.

`fixtures/day-twelve/` bunun ta kendisi: 08:14'te `GOLDADDRESS → GNEWADDRESS`
(`req:01J9RB6X3K`), 16:47'de `GNEWADDRESS → GOLDADDRESS` (`req:01J9SN7C2D`). İki
dosya, iki ref, iki anahtar, aynı `kind`. Ürünün bütün hikâyesi bu çift.

Bu kanal gateway'in; ilan edilen adres 402 cevabında yaşıyor, zincir onu
görmüyor. Ama kuralı bilmen lazım çünkü aynı "geçiş = gözlem" mantığı sende de
geçerli: bir durum değiştiyse değişimi yaz, bayrak koyma.

## 6. Horizon kaydından eşleme: `volume` ve `protocol`

Bu bölüm v0'ın kaynağı olan Horizon kayıtlarına göre yazıldı. SDF Horizon'u
ömrünün sonuna yaklaşmış sayıyor ve yerine Stellar RPC'yi gösteriyor; kapanma
tarihi yok, bugün çalışıyor. Kural Horizon'a değil gözleme bağlı: aşağıdaki
tablolar hangi zincir olgusunun hangi alana gittiğini söylüyor, Horizon alan
adları o olguyu bugün nereden aldığını. Kaynak değişirse tablonun sol sütunu
değişir, sağ sütunu değişmez. Eşleyiciyi kaynak okuyucudan ayrı yaz.

### `volume`: yön namespace'e göre

`direction` **namespace'e göre**dir, ödeyene göre değil. `"in"`: değer karşı
tarafa ulaştı. `"out"`: karşı taraftan çıktı. Bir zincir ödemesi iki gözlem
üretir: alıcının namespace'i için `"in"`, gönderenin namespace'i için `"out"`.
Anahtar namespace'i kapsıyor, ikisi de yaşar (bölüm 9).

Horizon `payment` kaydından kural:

| Horizon alanı | Gözlem |
|---|---|
| `to` | namespace `{ kind: "wallet", id: to }`, `direction: "in"` |
| `from` | namespace `{ kind: "wallet", id: from }`, `direction: "out"` |
| `amount` | `payload.amount` ve `salienceHints.amount`, olduğu gibi (yedi ondalık) |
| `asset_code` | `payload.assetCode`; `asset_type: "native"` ise `"XLM"` yaz (şema bunu kontrol etmez) |
| `id` | `source.ref: "op:<id>"` |
| ledger zamanı (`created_at`) | `observedAt` |
| `to_muxed_id` / `from_muxed_id` | `namespace.muxedId`, olduğu gibi (string). `id`'ye **girmez**; bölüm 7 ve 11 |

`path_payment_strict_send` ve `path_payment_strict_receive` için alıcı tarafı
`amount` + `asset_code`, gönderen tarafı `source_amount` + `source_asset_code`.
`create_account`: `account` tarafı `"in"`, `funder` tarafı `"out"`,
`starting_balance`, XLM; `kind: "create_account"`. Bunlar brief'teki "ödeme
ailesi üç tür" uyarısının karşılığı; sadece `payment`'a bakarsan bir kısmını hiç
görmezsin.

`create_account` **`volume`'un**dur, `protocol`'ün değil: kayıt bir değer
hareketidir (başlangıç bakiyesi funder'dan yeni hesaba geçer) ve bir kaynak
kayıt iki kanalda iki ad almaz. Hesabın "yeni" olması bir olgu olarak sonra
lazım olursa motor onu bu gözlemin tarihinden türetir; sen ayrıca yazmazsın.

Bizim kararımız, Horizon kuralı değil: **yalnızca takip ettiğin namespace'ler için
gözlem üret**; karşı taraf takipte değilse o tarafın gözlemi yoktur.

### `protocol`: hangi kayıt, hangi aralık, `event`'te ne var

`payload.event`, Horizon'un **effect tipi adını** taşır, olduğu gibi:
`trustline_created`, `trustline_removed`, `claimable_balance_claimant_created`,
`account_flags_updated`. `kind` ise bizim olay türü adımız (`trustline_open`).
İkisi ayrı çünkü biri Horizon'un sözlüğü, biri bizim; Horizon adı değişirse
`kind` değişmez.

| Horizon kaydı | Gözlem |
|---|---|
| `change_trust` op, `limit` sıfırdan büyük ve o hesap için bu varlıkta daha önce trustline yok (effect `trustline_created`) | **state**, `kind: "trustline_open"`, `validFrom: created_at`, `validUntil` yazılmaz, `ref: "op:<id>"`, namespace `trustor`. Payload: `event: "trustline_created"`, `assetCode`, `assetIssuer`, `issuerKnown`. `protocol.json` bu. |
| `change_trust` op, `limit: "0.0000000"` (effect `trustline_removed`) | **event**, `kind: "trustline_closed"`, `observedAt: created_at`, `ref` kapatan op, namespace `trustor`. Payload: `event: "trustline_removed"`, aynı varlık alanları. State'e dokunma (bölüm 4). |
| `change_trust` op, `limit` değişti ama sıfır değil (effect `trustline_updated`) | v0'da gözlem **yok**. Limit değişimi bir kabul ya da ret değil. |
| `create_claimable_balance` op'un her claimant'ı (effect `claimable_balance_claimant_created`, effect'teki `account`) | **event**, `kind: "claimable_balance_offered"`, `observedAt: created_at`, `ref: "op:<id>"`, namespace claimant. Payload: `event: "claimable_balance_claimant_created"`, `assetCode`, `assetIssuer`, `issuerKnown`. Bilinmeyen bir issuer'ın varlığını kapına bırakması airdrop tuzağının ilk adımı; `issuerKnown: false` o yüzden burada. Aynı op birden çok claimant'a giderse her biri ayrı namespace, ayrı anahtar. |
| `set_options` op, `set_flags_s` ya da `clear_flags_s` dolu (effect `account_flags_updated`) | **event**, `kind: "account_flags_changed"`, `observedAt: created_at`, `ref: "op:<id>"`, namespace `source_account`. Payload: `event: "account_flags_updated"`, varlık alanları yok. Hangi bayrağın değiştiğini taşıyacak alan payload'da **yok**; bölüm 14. |

`issuerKnown`: issuer senin bilinen-issuer listende var mı. Liste v0'da senin
elinde, kısa olacak (USDC issuer ve birkaç tane); listeyi repoya yaz, kartın
gövdesine not düş.

## 7. Namespace kuralları

`kind` dört değerden biri: `wallet`, `domain`, `endpoint`, `merchant`. Sen v0'da
hep `wallet` yazacaksın; fixture'lar `endpoint` çünkü hikâye bir x402 ucu.
`id` boş olamaz ve NUL içeremez (anahtarın ayırıcısı).

Adres, alan adı, uç: bunlar namespace'in **öznitelikleri**, namespace'in kendisi
değil. Daha zengin bir şey yoksa cüzdan adresi çıpadır.

**`id` bayt bayt karşılaştırılır.** Kırpma yok, büyük/küçük harf eşitleme yok,
URL normalizasyonu yok: `https://data.example/x402` ile
`https://data.example/x402/` iki ayrı namespace'tir, `GABC` ile `gabc` de. Bu
bir karar, kaza değil; motor kimlik çözmez ve iki yazımı sessizce
birleştirmez. Sonucu senin tarafta: bir adresi her yerde aynı yazımla yaz
(Horizon'un verdiği gibi, büyük harf), URL'yi bir kez seç ve değiştirme.
Kapısı `idempotency.test.ts`'de: yukarıdaki çiftler iki farklı anahtar türetir.

**Muxed adres taban adrese çözülür: `id`'ye taban adres (G...) yazılır, muxed
kimlik `namespace.muxedId`'ye.** Horizon zaten `to`'da taban adresi veriyor;
muxed alıcı varsa `to_muxed` (M...) ve `to_muxed_id` ayrıca gelir. `id`'ye
`to` yaz, `to_muxed`'ı asla; `to_muxed_id`'yi olduğu gibi `muxedId`'ye yaz
(`from` tarafı için `from_muxed_id`). `muxedId` anahtara girmez: aynı hesabın
iki muxed kimliğine giden iki ödeme aynı karşı taraf hakkındadır (bölüm 9).
İki ayrı `muxedId` var, karıştırma: **namespace'teki** gözlemin öznesinin
kimliği, **`address_integrity` payload'ındaki** ise bir geçişin içinde ilan
edilen adresin muxed kimliği; ikincisini sen üretmiyorsun. **Şema muxed
biçimi `id`'de reddediyor** (`@nonametrust/schema` 0.2.0'dan itibaren):
`kind: "wallet"` bir namespace'in `id`'sine M ile başlayan 69 karakterlik
base32 dizi yazarsan gözlem düşer ve `validateObservation`'dan şu gelir:
`namespace.id: a wallet id is the base address: resolve the muxed address and carry its subaccount in muxedId`.
Küçük harfe çevrilmiş hâli de düşer; kapısı `namespace.test.ts`'de. Kapı
bilerek tek yönlü: muxed biçimi reddediyor, taban adresin neye benzediğine
bakmıyor. Yani **`id`'nin checksum'ı geçerli bir Stellar hesabı olduğunu şema
kontrol etmiyor**; `GABC` de geçer, yanlış kopyalanmış bir G... de. O kural
senin uyacağın kural (bölüm 11). Brief'in 7. bölümündeki "muxed adres payı"
ölçümü de tam bu noktada sayılır: kaç ödeme muxed alıcı taşıdı, kaçını çözdün.

`continuity`: iki adresin aynı karşı taraf olduğunu söyleyen bir **beyandır**,
çıkarım değil. Motor kimlik çözmez, sessizce birleştirmez. Yazarsan `assertedBy`,
`assertedAt` (UTC), `reason` üçü de dolu gelir ve kanıt zinciri olarak saklanır.
v0'da yazmana gerek yok.

## 8. `source`: kim, nereden, ne zaman

| Alan | Kural |
|---|---|
| `producer` | Çıplak isim: `stellar-indexer`. Küçük harf, rakam, tek tire. Versiyon **buraya girmez**; girerse reddedilir. |
| `producerVersion` | `"0.1.0"`. Ayrı alan, çünkü anahtara girmiyor: versiyon yükselttiğinde depodaki her şeyin kopyası doğmasın. |
| `network` | `"stellar:pubnet"` ya da `"stellar:testnet"`; şema sadece boş olmadığına bakar, bu iki yazım bizim sözümüz (bölüm 11). Sen her zaman yaz; Stellar operasyon id'leri iki ağda çakışır, hangi API'den okunursa okunsun. Gateway'in ağı yok, o yazmıyor; isteğe bağlılığı bundan. |
| `ref` | Kaynak olayın kararlı referansı: `"op:214720397313"`. Aynı olayı yeniden okuduğunda **birebir aynı** çıkmalı. Operasyon id bunu sağlar ve kaynaktan bağımsızdır. Paging token Horizon'a özgü: kaynak değiştiği gün her anahtar değişir, o yüzden operasyon id'yi seç. NUL içeremez. |
| `fetchedAt` | Sen okuduğun an, UTC `Z`. Anahtara girmez; iki kez okuman iki gözlem doğurmaz. |

## 9. Anahtar, ve yeniden koşma garantisi

`idempotencyKey = sha256(producer \0 network \0 ref \0 channel \0 namespace.kind \0 namespace.id)`,
hex. `network` yoksa boş string. Ayırıcı NUL; şema hiçbir alanda NUL kabul
etmediği için iki alan sınırı kaydırılıp aynı anahtara varılamaz. Sıra dondu.

Pratikte anlamı:

- Aynı aralığı iki kez okursan aynı anahtarlar çıkar, sıfır yeni gözlem. Nasıl
  ölçeceğin 1. bölümde. Motor tarafında doğruluk meselesi: kopya iz, etiketleme
  hattına kanıtı iki kat güçlü gösterir.
- `fetchedAt` ve `producerVersion` anahtarda yok; yeniden okuma ve sürüm yükseltme
  kopya doğurmaz.
- Namespace anahtarda **var**; bir ödemenin iki tarafı aynı ref'i paylaşır ve
  ikisi de yaşar.
- `kind`, `evidenceKind` ve payload anahtarda **yok**. Yani bir `(ref, channel,
  namespace)` üçlüsünden en fazla bir gözlem üret; ikincisi kopya sayılır. Aynı
  op'tan aynı kanalda aynı karşı taraf için iki şey söylemen gerekirse bu bir
  sözleşme sorusudur, ref'i oynayarak çözme; bölüm 14.

Anahtarı önceden hesaplamak istersen `deriveIdempotencyKey(source, channel,
namespace)` export edilmiş; kendi tekilleştirmeni motorla aynı anahtar
üzerinden kurabilirsin.

## 10. Motorun atadığı alanlar

`observationId`, `ingestedAt`, `idempotencyKey` motorun. İlk ikisi telde
**görünmez**; görünürse, değeri ne olursa olsun (`null` bile), gözlem reddedilir:
`observationId: assigned by the engine on ingest and must not appear on the wire`.
Kontrol `in` ile, değere bakmıyor; TypeScript'ten doğrudan çağırıyorsan
`observationId: undefined` bile reddedilir. Motor tarafındaki bir objeyi
spread'leyip tele geri yazdığında olur bu, çözümü de aynı: anahtarı düşür.
`idempotencyKey`'i yazabilirsin ama türetilenle aynı olması şart; farklıysa
reddedilir ve mesaj türetilen anahtarı gösterir. Sessizce düzeltmiyoruz, çünkü o
zaman sen ve motor "kopya nedir" konusunda farklı düşünür ve kimse öğrenmez.
En kolayı: üçünü de yazma. (Diske yazarken satırda `idempotencyKey` olması
normal; o `validateObservation`'ın çıktısı, senin girdin değil.)

## 11. Şemanın kontrol **etmediği** kurallar

Bunlar doğru olmak zorunda ve bugün doğruluğunu sadece sen sağlıyorsun. Her
birini kendi tarafında bir teste bağla; "cümle olarak değersiz, test olarak
değerli" burada geçerli.

1. **Cüzdan `id`'sinin checksum'ı geçerli bir Stellar hesabı olması, ve
   `muxedId`'nin gerçekten o adresin kimliği olması** (bölüm 7). Şema M ile
   başlayan 69 karakterlik base32 diziyi `id`'de reddediyor, o kadar; taban
   adresin biçimine bakmıyor, checksum hesaplamıyor, `muxedId`'yi adresle
   karşılaştıramaz. Yanlış kopyalanmış bir G... geçer.
2. **`kind` sözlüğü** (bölüm 12). Şema `kind`'ın boş olmadığına bakıyor, başka
   hiçbir şeye.
3. **`direction`'ın doğru tarafta olması.** Şema `"in"`/`"out"` olduğuna bakar,
   Horizon'un `to`/`from`'una göre doğru olup olmadığını bilemez.
4. **`assetCode` yazımı.** Native için `"XLM"` bizim sözümüz, şema `min(1)` string
   görüyor.
5. **`ref` kararlılığı.** Aynı olaya aynı ref; bunu ancak 1. bölümdeki iki koşu
   testi yakalar.
6. **Bir `(ref, channel, namespace)` → en fazla bir gözlem** (bölüm 9).
7. **`salienceHints`'in payload ile aynı değeri taşıması.** Şema iki alanı ayrı
   ayrı doğrular, birbirine bakmaz.
8. **`network`'ün indexer'da her zaman dolu olması ve iki yazımdan biri olması**
   (`"stellar:pubnet"`, `"stellar:testnet"`; bölüm 8). Şema sadece boş ve NUL'suz
   olmasına bakar, çünkü gateway'in ağı yok. Boş bırakırsan pubnet ve testnet
   operasyonları aynı anahtara düşer ve biri sessizce kaybolur; farklı yazarsan
   aynı ağ iki ağ sayılır.
9. **`payload.event`'in Horizon effect adı olması** (bölüm 6). Şema boş olmayan
   string görüyor.
10. **Bir state'in hiç yeniden yazılmaması, bitişin ayrı event olması** (bölüm 4).
    Şema iki gözlemi ayrı ayrı doğrular; ilişkiyi motor M1'de kurar.
11. **`protocol` payload'ında `issuerKnown`'ın varlıklı her kayıtta yazılması**
    (bölüm 6). Airdrop tuzağı tam bu alana yaslanıyor (`issuerKnown: false`),
    ama şemada isteğe bağlı: yazmazsan gözlem geçer ve motor "bilinmiyor" ile
    "bilinmeyen issuer"ı ayıramaz. `assetCode` taşıyan her `protocol`
    gözleminde `issuerKnown`'ı doldur; listende yoksa `false`.

Şemanın kontrol **ettiği** şeyleri saymıyorum; onlar zaten hata mesajı olarak
sana gelir.

## 12. `kind`: serbest string, sözlüğü henüz dondurulmadı

`kind` kaynakta ne olduğunu söyler; kanalla aynı şey değil. Enum **değil**, bilerek:
ihtiyacın olan sözlük eşleyici yazılmadan bilinmiyor ve şimdi dondurursak M1
boyunca her hafta değiştiririz. Bedeli şu: aynı olayı iki yerde iki farklı
yazarsan ikisi de geçer ve kimse fark etmez. O yüzden kural: **bir kaynak olay
türü tek bir `kind` yazımı alır, bir kez seçilir, her yerde o kullanılır.**
Fixture'lardaki yazımlar referans. Geri dönüşün `kind`'ı ileri gidişle aynıdır
(`payment_address_changed`), çünkü aynı olay türü: bir geçiş.

Beklediğimiz `kind`'lar, kanal başına. İki sütun ayrı tutuldu: soldakiler bir
fixture'da duruyor ve testten geçiyor, sağdakiler bu dokümandan başka hiçbir
yerde yok, önerdik. **Şema ikisini de kontrol etmiyor**; sözlük, indexer
gerçekte ne ürettiğini gördükten sonra dondurulacak.

| Kanal | Fixture'da var | Önerilen, henüz hiçbir yerde yok |
|---|---|---|
| `volume` | `payment` | `path_payment`, `create_account` |
| `protocol` | `trustline_open` (state) | `trustline_closed` (event), `claimable_balance_offered` (event), `account_flags_changed` (event) |
| `content` | `memo` | – |
| `cluster_proximity` | `dust_received` | – |
| `latency` (gateway) | `response_received` | – |
| `price` (gateway) | `price_quoted` | – |
| `address_integrity` (gateway) | `payment_address_changed` | – |

Bir yeni `kind` gerekirse ekle, fixture'a yaz, kartın gövdesine not düş. Listeyi
dondurduğumuzda enum olacak ve o gün yazımı değiştirmek göç demek; o yüzden
şimdi tutarlı ol.

## 13. Repoya dosya eklerken

Kökte bir kapı var: izlenen hiçbir dosyada Stellar hesap adresi şeklinde bir
şey olamaz, G ile başlayan 56 ya da M ile başlayan 69 karakterlik base32
dizi, checksum geçerli olsun olmasın, küçük harfe çevrilmiş ya da başına
sonuna bir şey yapışmış olsa da. Kapı yolları git index'inden, içeriği çalışma
ağacından okur: `git add` ettiğin dosya commit'ten önce taranır, ama
stage'leyip sonra yerelde temizlediğin bir adres yerelde geçer, onu commit
edilmiş ağaç üzerinde koşan CI yakalar. Senin paketin de kapsamda. Test
fixture'larında kısa, belli ki sahte kimlikler kullan (`GOLDADDRESS` gibi);
gerçek biçimli bir anahtara ihtiyacın olan test onu çalışma anında üretir ve
dosyaya yazmaz. Bu kural
pazarlık dışı; repo v0'da public oluyor ve bu projenin arkasındaki veri
dolandırılmış hesapları tanımlıyor.

## 14. Açık noktalar, birlikte kapatacağız

- **Memo op'a mı işleme mi bağlı?** Memo işlemin (transaction) özelliği, ödeme
  operasyonun. Fixture memo'yu ödeme op'unun ref'iyle yazıyor ki `volume` ile
  `content` aynı `source`'u paylaşsın. Bir işlemde aynı karşı tarafa birden
  fazla op varsa memo kaç gözlem olur, ilk gün konuşalım.
- **Aynı op, aynı kanal, aynı karşı taraf için iki gözlem gerekirse ne olur?**
  Anahtar buna yer bırakmıyor (bölüm 9). Bugün böyle bir durum bilmiyoruz;
  eşleyiciyi yazarken çıkarsa mekanizma uydurmadan getir, sözleşmede çözelim.
- **Hesap bayrakları.** `protocol` payload'ında hangi bayrağın değiştiğini
  taşıyacak alan yok; v0 sadece değiştiğini kaydediyor. Alan gerekirse şemaya
  ekleriz, sen `event`'e sıkıştırma.
- **Horizon sonrası okuyucu.** v0 Horizon'dan okuyor. Yerine gösterilen Stellar
  RPC işlem ve olay geçmişini yalnızca yedi gün tutuyor ve hesaba göre ödeme ya
  da efekt ucu vermiyor, yani 30 günlük geri doldurma bugün Horizon'a bağlı.
  Kapanma duyurulduğunda seçenekler RPC `getLedgers` artı ham XDR ayrıştıran bir
  veri gölü, ya da ücretli indeksli bir API. Kararı şimdi vermiyoruz; verilmesi
  gereken tek şey kaynak okuyucunun ayrı bir katman olması.
- **`kind` sözlüğü** bölüm 12'de; ilk eşleyici çıktısından sonra donduracağız.

Sorusu olan yeri işaretle, oturup konuşalım. Fixture'la çelişen bir şey görürsen
fixture'ı düzeltiriz; bu doküman değil kod ve fixture'lar sözleşmenin kaynağı.
