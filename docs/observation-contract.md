# Gözlem sözleşmesi (A0)

Atahan, bu doküman indexer'ın motora ne vereceğini anlatıyor. Şema
`packages/schema` içinde, kod ve fixture'lar burada yazılanla birebir aynı;
ikisi ayrışırsa kod haklıdır ve bu dokümanı düzeltiriz. Bir saat içinde eşleyiciyi
yazmaya başlayabilmen için yazıldı, o yüzden sıra: önce nasıl kullanılır, sonra
alanlar, sonra şemanın **kontrol etmediği** kurallar. O son bölüm en önemlisi;
düzyazıda duran ve kimsenin zorlamadığı her iddia bu projede yanlış çıktı, o
yüzden zorlanmayan kural burada "zorlanmıyor" diye açıkça yazılı.

## 1. Nereden başlıyorsun

Paket `@nonametrust/schema`, tek bağımlılığın bu. Kendi paketine şöyle bağla:

```json
"dependencies": { "@nonametrust/schema": "workspace:*" }
```

`main` alanı `dist/index.js`'e bakıyor, yani repoda önce bir kez `pnpm build`
koşman gerekiyor. Sonra:

```ts
import { validateObservation, deriveIdempotencyKey } from "@nonametrust/schema";
import type { Observation, VolumePayload, PayloadByChannel } from "@nonametrust/schema";

const r = validateObservation(obj);      // obj: parse edilmiş JSON, string değil
if (!r.ok) console.error(r.errors);       // ["alan: mesaj", ...]
else store(r.value);                      // r.value.idempotencyKey atanmış geliyor
```

Hatalar `alan: mesaj` biçiminde ve kontrol sırası şu: obje mi, motorun alanları
var mı, `schemaVersion` tam eşleşiyor mu, zarf, kanalın payload'ı, varsa
`idempotencyKey` türetilenle aynı mı. İlk düşen katmanda duruyor; yani önce
şekil hatalarını görürsün, anahtar en sonda.

Örnekler `packages/schema/fixtures/` altında, kanal başına bir dosya. Yedisi tek
hikâye: bir x402 veri sağlayıcısı, 20 Ağustos–12 Eylül 2026. Eşleyicinin
ürettiğini bu dosyalarla yan yana koy; alan adı ve biçim farkı varsa yanlış
taraf büyük ihtimalle senin taraf değil, ama fixture da olabilir, söyle.

Testler: repo kökünde `pnpm test`. Kendi paketini eklediğinde `pnpm -r test` onu
da koşar.

## 2. Zarf: her gözlemde olan alanlar

| Alan | Tip | Kural |
|---|---|---|
| `schemaVersion` | string | Şimdilik `"0.1.0"`. Tam eşleşme; başka değer reddedilir. |
| `namespace` | `{ kind, id, continuity? }` | Gözlemin **kim hakkında** olduğu. Bölüm 6. |
| `channel` | enum | Yedi kanaldan biri. Bölüm 3. |
| `evidenceKind` | `"event"` \| `"state"` | Anlık olay mı, süren durum mu. Bölüm 4. |
| `kind` | string | Kaynakta ne oldu: `payment`, `memo`, `trustline_open`. Kanal değil. Serbest metin; bölüm 10. |
| `observedAt` | UTC zaman | Sadece event'te, zorunlu. |
| `validFrom`, `validUntil` | UTC zaman, `validUntil` null olabilir | Sadece state'te. `validUntil` yazılmazsa null sayılır, "hâlâ sürüyor" demek. `validUntil < validFrom` reddedilir. |
| `source` | obje | Bunu kim, nereden, ne zaman okudu. Bölüm 7. |
| `payload` | obje | Kanala özgü, zorunlu, boş obje bile olsa obje. Bölüm 3. |
| `salienceHints` | `{ amount?, latencyMs? }` | İsteğe bağlı. Payload depoda şifreli duracak; önem hesabı payload'ı açmadan bu ipuçlarını okuyor. `volume` yazıyorsan `amount`'ı, `latency` yazıyorsan `latencyMs`'i buraya da yaz. |
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
  `cluster_proximity`, `content`.
- **`x402-gateway`**: 402 cevabının içinde olan şeyler, zincirde hiç görünmez.
  `latency`, `price`, `address_integrity`. Bunları sen üretmiyorsun; fixture'larda
  duruyorlar ki `producer`'ın sabit olmadığını ve `network`'ün isteğe bağlı
  olduğunu göresin.

| Kanal | Ne | Üretici | Payload | Fixture | Fixture'daki `kind` |
|---|---|---|---|---|---|
| `volume` | Değer hareketi | indexer | `amount` string, `assetCode`, `direction: "in" \| "out"` | `volume.json` | `payment` |
| `protocol` | Protokol seviyesinde olgu: trustline, kabul edilen varlık, hesap bayrağı | indexer | `event` zorunlu; `assetCode?`, `assetIssuer?`, `issuerKnown?: boolean` | `protocol.json` | `trustline_open` |
| `cluster_proximity` | Bilinen bir operasyon kümesine graf yakınlığı | indexer | `clusterId`, `hops` pozitif tam sayı (doğrudan temas = 1), `amount?` string | `cluster_proximity.json` | `dust_received` |
| `content` | Karşı tarafın ürettiği serbest metin | indexer | `text`, `field: "memo" \| "error" \| "response"` | `content.json` | `memo` |
| `latency` | Cevap süresi | gateway | `latencyMs: number ≥ 0` | `latency.json` | `response_received` |
| `price` | İstenen fiyat | gateway | `quoted` string, `unit` (`"USDC"`) | `price.json` | `price_quoted` |
| `address_integrity` | İlan edilen ödeme adresinin değişmesi | gateway | `previous` zorunlu, `current` zorunlu, `muxedId?` | `address_integrity.json` ve `day-twelve/` | `payment_address_changed` |

Bir zincir olayı birden fazla gözlem üretebilir, her gözlem tek kanal taşır.
`volume.json` ile `content.json` bilerek aynı operasyondur: aynı `source`, iki
kanal, iki farklı anahtar. Ödeme ve memosu böyle akar.

Payload tipleri export edilmiş: `VolumePayload` yazılı bir interface (yön kuralı
doc comment'inde), diğer altısı `PayloadByChannel["protocol"]` gibi map üzerinden
geliyor. Eşleyicinin dönüş tipini bunlardan seç, uydurma.

## 4. `event` mi `state` mi

Event bir anda oldu: ödeme, memo, adres değişimi. `observedAt` taşır, aralık
taşımaz. State bir süre boyunca geçerli: açık trustline, genç hesap. `validFrom`
ve `validUntil` taşır, an taşımaz. Şema iki yönde de sıkı; state'e `observedAt`
yazamazsın.

Neden bu kadar katı: ölçüm çalışmasında S3 sinyali tarihsiz bir durumdu.
Analiz onu her pencereye, yedi günlük olana bile, "isabet" diye yazdı; kontrol
kolunda ise hiç ölçülemedi. Fark tek yönlüydü ve manşeti üç puan şişirdi. Motor
bir state'i hiçbir zaman zaman hesabına sokmaz (`datedAt` state için null döner
ve bunun kapısı var). Sen de bir olguyu tarihlemek için `observedAt`'a
sıkıştırma; süren bir şeyse state'tir. Örnek `protocol.json`: trustline 20
Ağustos'ta açıldı, `validUntil: null`, hâlâ sürüyor.

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

## 6. `volume`'da yön, ve Horizon kaydından eşleme

`direction` **namespace'e göre**dir, ödeyene göre değil. `"in"`: değer karşı
tarafa ulaştı. `"out"`: karşı taraftan çıktı. Bir zincir ödemesi iki gözlem
üretir: alıcının namespace'i için `"in"`, gönderenin namespace'i için `"out"`.
Anahtar namespace'i kapsıyor, ikisi de yaşar (bölüm 8).

Horizon `payment` kaydından kural:

| Horizon alanı | Gözlem |
|---|---|
| `to` | namespace `{ kind: "wallet", id: to }`, `direction: "in"` |
| `from` | namespace `{ kind: "wallet", id: from }`, `direction: "out"` |
| `amount` | `payload.amount` ve `salienceHints.amount`, olduğu gibi (yedi ondalık) |
| `asset_code` | `payload.assetCode`; `asset_type: "native"` ise `"XLM"` yaz (şema bunu kontrol etmez) |
| `id` | `source.ref: "op:<id>"` |
| ledger zamanı (`created_at`) | `observedAt` |
| `to_muxed_id` / `from_muxed_id` | namespace'e **girmez**; bölüm 7 ve 11 |

`path_payment_strict_send` ve `path_payment_strict_receive` için alıcı tarafı
`amount` + `asset_code`, gönderen tarafı `source_amount` + `source_asset_code`.
`create_account`: `account` tarafı `"in"`, `funder` tarafı `"out"`,
`starting_balance`, XLM. Bunlar brief'teki "ödeme ailesi üç tür" uyarısının
karşılığı; sadece `payment`'a bakarsan bir kısmını hiç görmezsin.

Yalnızca takip ettiğin namespace'ler için gözlem üret; karşı taraf takipte
değilse o tarafın gözlemi yoktur.

## 7. Namespace kuralları

`kind` dört değerden biri: `wallet`, `domain`, `endpoint`, `merchant`. Sen v0'da
hep `wallet` yazacaksın; fixture'lar `endpoint` çünkü hikâye bir x402 ucu.
`id` boş olamaz ve NUL içeremez (anahtarın ayırıcısı).

Adres, alan adı, uç: bunlar namespace'in **öznitelikleri**, namespace'in kendisi
değil. Daha zengin bir şey yoksa cüzdan adresi çıpadır.

**Muxed adres taban adrese çözülür, namespace id'sine taban adres (G...) yazılır,
muxed kimlik özniteliktir.** Horizon zaten `to`'da taban adresi veriyor; muxed
alıcı varsa `to_muxed` (M...) ve `to_muxed_id` ayrıca gelir. Namespace'e `to`
yaz, `to_muxed`'ı asla. **Şema bunu v0'da kontrol etmiyor**: `id`'ye M ile
başlayan 69 karakter yazarsan geçer. Kural senin uyacağın kural; M1'de kapısı
eklenecek. Brief'in 7. bölümündeki "muxed adres payı" ölçümü de tam bu noktada
sayılır: kaç ödeme muxed alıcı taşıdı, kaçını çözdün.

`continuity`: iki adresin aynı karşı taraf olduğunu söyleyen bir **beyandır**,
çıkarım değil. Motor kimlik çözmez, sessizce birleştirmez. Yazarsan `assertedBy`,
`assertedAt` (UTC), `reason` üçü de dolu gelir ve kanıt zinciri olarak saklanır.
v0'da yazmana gerek yok.

## 8. `source`: kim, nereden, ne zaman

| Alan | Kural |
|---|---|
| `producer` | Çıplak isim: `stellar-indexer`. Küçük harf, rakam, tek tire. Versiyon **buraya girmez**; girerse reddedilir. |
| `producerVersion` | `"0.1.0"`. Ayrı alan, çünkü anahtara girmiyor: versiyon yükselttiğinde depodaki her şeyin kopyası doğmasın. |
| `network` | `"stellar:pubnet"` ya da `"stellar:testnet"`. Sen her zaman yaz; Horizon operasyon id'leri iki ağda çakışır. Gateway'in ağı yok, o yazmıyor; isteğe bağlılığı bundan. |
| `ref` | Kaynak olayın kararlı referansı: `"op:214720397313"`. Aynı olayı yeniden okuduğunda **birebir aynı** çıkmalı. Operasyon id bunu sağlar; paging token da olur ama birini seç ve değiştirme. NUL içeremez. |
| `fetchedAt` | Sen okuduğun an, UTC `Z`. Anahtara girmez; iki kez okuman iki gözlem doğurmaz. |

## 9. Anahtar, ve yeniden koşma garantisi

`idempotencyKey = sha256(producer \0 network \0 ref \0 channel \0 namespace.kind \0 namespace.id)`,
hex. `network` yoksa boş string. Ayırıcı NUL; şema hiçbir alanda NUL kabul
etmediği için iki alan sınırı kaydırılıp aynı anahtara varılamaz. Sıra dondu.

Pratikte anlamı:

- Aynı aralığı iki kez okursan aynı anahtarlar çıkar, sıfır yeni gözlem. Bu senin
  16 Eylül kabul ölçütün ve motor tarafında doğruluk meselesi: kopya iz,
  etiketleme hattına kanıtı iki kat güçlü gösterir.
- `fetchedAt` ve `producerVersion` anahtarda yok; yeniden okuma ve sürüm yükseltme
  kopya doğurmaz.
- Namespace anahtarda **var**; bir ödemenin iki tarafı aynı ref'i paylaşır ve
  ikisi de yaşar.
- `kind`, `evidenceKind` ve payload anahtarda **yok**. Yani bir `(ref, channel,
  namespace)` üçlüsünden en fazla bir gözlem üret; ikincisi kopya sayılır. Aynı
  op'tan aynı kanalda aynı karşı taraf için iki şey söyleyeceksen ref'i ayır
  (`op:<id>#2` gibi) ya da tek gözleme sığdır; hangisi olacağına birlikte karar
  verelim, bölüm 12.

Anahtarı önceden hesaplamak istersen `deriveIdempotencyKey(source, channel,
namespace)` export edilmiş; kendi tekilleştirmeni motorla aynı anahtar
üzerinden kurabilirsin.

## 10. Motorun atadığı alanlar

`observationId`, `ingestedAt`, `idempotencyKey` motorun. İlk ikisi telde
**görünmez**; görünürse, değeri ne olursa olsun (`null` bile), gözlem reddedilir:
`observationId: assigned by the engine on ingest and must not appear on the wire`.
`idempotencyKey`'i yazabilirsin ama türetilenle aynı olması şart; farklıysa
reddedilir ve mesaj türetilen anahtarı gösterir. Sessizce düzeltmiyoruz, çünkü o
zaman sen ve motor "kopya nedir" konusunda farklı düşünür ve kimse öğrenmez.
En kolayı: üçünü de yazma.

## 11. Şemanın kontrol **etmediği** kurallar

Bunlar doğru olmak zorunda ve bugün doğruluğunu sadece sen sağlıyorsun. Her
birini kendi tarafında bir teste bağla; "cümle olarak değersiz, test olarak
değerli" burada geçerli.

1. **Muxed → taban adres** (bölüm 7). Şema `id`'nin biçimine bakmıyor. M1'de kapı.
2. **`kind` sözlüğü** (bölüm 12). Şema `kind`'ın boş olmadığına bakıyor, başka
   hiçbir şeye.
3. **`direction`'ın doğru tarafta olması.** Şema `"in"`/`"out"` olduğuna bakar,
   Horizon'un `to`/`from`'una göre doğru olup olmadığını bilemez.
4. **`assetCode` yazımı.** Native için `"XLM"` bizim sözümüz, şema `min(1)` string
   görüyor.
5. **`ref` kararlılığı.** Aynı olaya aynı ref; bunu ancak "aynı aralığı iki kez
   koş, sıfır yeni gözlem" testi yakalar.
6. **Bir `(ref, channel, namespace)` → en fazla bir gözlem** (bölüm 9).
7. **`salienceHints`'in payload ile aynı değeri taşıması.** Şema iki alanı ayrı
   ayrı doğrular, birbirine bakmaz.

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

Beklediğimiz `kind`'lar, kanal başına. **Şema bunları kontrol etmiyor**; sözlük,
indexer gerçekte ne ürettiğini gördükten sonra dondurulacak.

| Kanal | Beklenen `kind`'lar |
|---|---|
| `volume` | `payment`, `path_payment`, `create_account`, `claimable_balance_claimed` |
| `protocol` | `trustline_open`, `trustline_closed`, `account_flags_changed`, `account_created` |
| `cluster_proximity` | `dust_received` |
| `content` | `memo` |
| `latency` (gateway) | `response_received` |
| `price` (gateway) | `price_quoted` |
| `address_integrity` (gateway) | `payment_address_changed` |

Bir yeni `kind` gerekirse ekle, fixture'a yaz, kartın gövdesine not düş. Listeyi
dondurduğumuzda enum olacak ve o gün yazımı değiştirmek göç demek; o yüzden
şimdi tutarlı ol.

## 13. Repoya dosya eklerken

Kökte bir kapı var: izlenen hiçbir dosyada Stellar hesap adresi şeklinde bir
şey olamaz, G ile başlayan 56 ya da M ile başlayan 69 karakter, checksum
geçerli olsun olmasın. `git add` ettiğin anda taranır ve senin paketin de
kapsamda. Test fixture'larında kısa, belli ki sahte kimlikler kullan
(`GOLDADDRESS` gibi); gerçek biçimli bir anahtara ihtiyacın olan test onu
çalışma anında üretir ve dosyaya yazmaz. Bu kural pazarlık dışı; repo v0'da
public oluyor ve bu projenin arkasındaki veri dolandırılmış hesapları
tanımlıyor.

## 14. Açık noktalar, birlikte kapatacağız

- **Memo op'a mı işleme mi bağlı?** Memo işlemin (transaction) özelliği, ödeme
  operasyonun. Fixture memo'yu ödeme op'unun ref'iyle yazıyor ki `volume` ile
  `content` aynı `source`'u paylaşsın. Bir işlemde aynı karşı tarafa birden
  fazla op varsa memo kaç gözlem olur, ilk gün konuşalım.
- **`protocol.event` ile `kind` çakışıyor mu?** Fixture'da `kind:
  "trustline_open"`, `payload.event: "trustline_established"`. İki alan aynı
  şeyi mi söylüyor, yoksa `event` Horizon'un effect adı mı olacak? Sen Horizon'dan
  ne geldiğini görünce netleşir.
- **`kind` sözlüğü** bölüm 12'de; ilk eşleyici çıktısından sonra donduracağız.

Sorusu olan yeri işaretle, oturup konuşalım. Fixture'la çelişen bir şey görürsen
fixture'ı düzeltiriz; bu doküman değil kod ve fixture'lar sözleşmenin kaynağı.
