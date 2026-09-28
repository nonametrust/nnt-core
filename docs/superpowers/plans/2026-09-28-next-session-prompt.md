# Sıradaki session için prompt

> Bu dosya bir sonraki session'a verilecek promptu taşıyor. Aşağıdaki bloğu
> olduğu gibi kopyala. Kendisi de repo'da, çünkü bir handoff'u sohbet geçmişinde
> bırakmak onu kaybetmenin en kolay yolu.

---

nnt-core'da M3'e devam ediyoruz. **Görev 1-4 bitti ve dört review turundan geçti;
sıradaki iş Görev 5, brief'in çekirdeği.** Dal `m3-sync-path`, çalışma dizini
`/Users/keremkaya/Desktop/firma/nnt-core` — oturum başka bir depoda açılırsa (ör.
`nonametrust`, o ölçüm çalışması) oraya geç.

ÖNCE OKU, bu sırayla:
  docs/superpowers/plans/2026-09-28-m3-task-5-requirements.md
    Görev 5'in şartnamesi. Plandaki Görev 5 metni Görev 1-4 koşmadan ÖNCE
    yazıldı; bu dosya deltayı taşıyor. Input/output şekli burada, bir yerde ve
    bütün — beş yere dağılmış hâlinden bir review'ın tahmin etmek zorunda
    kalmasıyla yazıldı.
  docs/superpowers/ledgers/2026-09-27-m3-decisions.md
    R33-R48, yani planın taşımadığı ON ALTI ruling, her biri ölçümüyle ve neye
    mal olduğuyla. "Round three, lens three" ve "R43-R48" bölümleri Görev 5'in
    zemini. Plandan daha yeni; çeliştikleri yerde bu kazanır ve nedenini söyler.
  docs/superpowers/plans/2026-09-27-m3-sync-path.md
    R1-R32, §3 genel kısıtlar, §3b mutasyon adımı, §5 kapı tablosu. Hâlâ otorite,
    ama R33-R48 onu dört yerde değiştiriyor.
  git log --oneline 11db2ac..HEAD

DİSİPLİN, bu sırayla ve atlamadan:
  1. test önce yaz, KIRMIZI GÖR, sonra kodu yaz
  2. yeşilden sonra MUTASYON — her kuralı tek tek kaldır ve HANGİ testin
     kırmızıya döndüğünü KAYDET. Hayatta kalan bir mutant, tutulmayan bir kural
  3. commit, sonra fable subagent'larla adversarial review (ayrı worktree, ayrı
     veritabanı, **detached HEAD**)
  4. bulguları düzelt ve düzeltmeleri de mutasyonla doğrula

BU DALIN PAHALIYA ÖĞRENDİĞİ ALTI ŞEY — hepsi burada, bu milestone'da oldu:

  - **Bir düzeltme, yerini aldığı davranışa karşı regresyon testi ister.** Bir
    kapıyı yeniden yazdım ve eskisinin reddettiği DÖRT clock okuması geçti. Bir
    false positive'i kapatmak için pattern'i sabitledim ve DOKUZ gerçek import
    biçimi düştü. Süit sadece "ağaç temiz mi" diye soruyordu.
  - **TİP değil DEĞER doğrula.** Yeni bir okuma Mart satırı için Şubat
    döndürüyordu; tek doğrulama `toBeInstanceOf(Date)` olduğu için dört saat
    dilimi koşusu da göremedi.
  - **Temiz bir ağaç üzerinde çalışan bir tarama hiçbir şey kanıtlamaz.** On iki
    düzeltme hiçbir şey tarafından tutulmuyordu. Her kural, kendisini ihlal eden
    SENTETİK bir girdiyle tutulmalı.
  - **Prose kayar, bulgular kalır.** Dört turun her biri, kodu düzeltilmiş ama
    çevresindeki cümlesi düzeltilmemiş bir şey buldu. En kötüsü: ledger'ın R37'si,
    `policy.ts`'in "yanlıştı" diye kaydettiği modeli taşımaya devam ediyordu — ve
    Görev 9'un kabulü ondan türetiliyor.
  - **`pnpm test` geçmesi `pnpm typecheck` geçmesi demek değil.** Bu dalda iki kez
    ayrıştılar; ikisini de koştur ve çıkış kodlarını AYRI oku.
  - **Asla borudan exit code okuma.** `cmd | tail` tail'in kodunu döndürür.
    `cmd > f 2>&1; echo "EXIT=$?"` sonra grep.

GÖREV 5 İÇİN EN ÖNEMLİ RULING **R39**, ve iki review lensi ona bağımsız olarak
vardı: **eşiği DÜŞÜREN etiket kümesi, GEREKÇE kümesidir — aktif VE ilişkili.**
`isReason(tag, intent, policy)` bunu uyguluyor; ikisini ayrı hesaplama. Bedeli:
Görev 6'nın `thresholdFor`'u intent'ten bağımsız olamaz, ve R44 gereği eşik
aritmetiğini + birim reddini Görev 5 yapıyor.

ORTAM:
  export NNT_TEST_DATABASE_URL=postgres://nnt@127.0.0.1:55432/nnt_test
  Ayakta değilse: ./packages/store/scripts/dev-db.sh up
  Şu anki sayımlar: schema 117, tagging 329, indexer 122, store 532, engine 190,
  kök kapılar 64. Hepsi yeşil olmalı — `pnpm build`, `pnpm typecheck`, `pnpm test`
  üçü de — başlamadan doğrula.

REVIEW BRIEF'İNDE HER ZAMAN OLACAKLAR:
  - Her ajan KENDİ worktree'sinde, KENDİ veritabanında, **detached HEAD'de**.
    Paylaşılan bir branch ref'i bir ajanın `git reset --hard`'ıyla senin
    commit'ini yok eder — bu dalda oldu ve bir commit gitti.
  - Atanan worktree yanlış repo olabilir; kontrol etmelerini söyle.
  - Önceki turların mutantlarını commit mesajlarına güvenmek yerine kendileri
    yeniden koştursunlar.
  - Süiti birkaç süreç saat diliminde VE değiştirilmiş bir veritabanı oturum saat
    diliminde koştursunlar. `America/St_Johns` (yarım saatlik ofset) bir hata
    yakaladı; `ALTER DATABASE` komutu `-d` olmadan exit 2 veriyor, yani başarısız
    bir ALTER'dan sonraki koşu hiçbir şey kanıtlamaz.

GÖREV 5'İN İNŞA EDECEĞİ ŞEYLER şartname dosyasında sırayla yazılı: composition
root (+ clock kimlik testi + leksikal kural), çekirdek (saf), wrapper (efektleri
uygulayan tek giriş noktası), ve altı kapı. Kapıların her biri için "neye ihtiyacı
var" notu da orada — özellikle R25'in blacklist DEĞİL, her derinlikte nesneyi
YÜRÜYEN bir whitelist olması gerektiği.

MÜHENDİSLİK DIŞINDA AÇIK DURANLAR, kaybetmeyelim:
  - Interest form ve referrer Kerem'de; başvuru hedefi ~1 hafta, public repo
    başvurudan hemen önce.
  - Sezer tarafı: veri-sınırı belgesinin §6'sı, §15'e yazılacak karşılaştırma
    kuralı, SHAM_PREREG r5, analyze.py placebo kapısı, dört sentinel.
  - Landing sitesinde lisanssız deneme yazı tipi (Monument Grotesk Mono) canlı
    serviste — panodaki tek madde ki yanlış olmanın bedeli hukuki.
  - **Dışa dönük üç cümle README'ye borçlu** (R33, R46, R47): brief kalıcı
    kayıtları okumuyor, `cluster_proximity` intent'i M3'te brief edilemiyor, ve
    bir gerekçe kaynak referansı değil bir KOD taşıyor.
