# Unipakt Görev Masası

Akif, Mehmet ve Uğur için ortak görev listesi, tamamlanma raporu ve kişi başına yapışkan not. Arayüz GitHub Pages’te, ortak veriler Supabase’te çalışır.

## Supabase kurulumu

Yeni kurulumda Supabase SQL Editor’da önce `supabase/schema.sql`, ardından `supabase/security_hardening.sql` dosyasını çalıştırın. ardından `supabase/v2_features.sql`, en son `supabase/v3_team.sql` dosyasını çalıştırın. Mevcut kurulumda henüz çalıştırılmamış olanları bu sırayla birer kez çalıştırmanız yeterli (veriler korunur, tekrar çalıştırmak zararsızdır). Önceki ortak kod kurulumunu yaptıysanız, kişi başına ayrı kodlara geçmek için `supabase/migrate_profile_pins.sql` dosyasını çalıştırın. Görev ve not tablolarına doğrudan anonim erişim kapalıdır. Her profilin 4 haneli kodu ayrı ayrı Supabase’te bcrypt özeti olarak saklanır. Başarılı giriş 12 saatlik geçici oturum açar; oturum anahtarı tarayıcı depolamasına yazılmaz. Not işlemleri yalnızca giriş yapan profilin notuna izin verir.

Önce kendi profilinizi seçin. İlk kullanımda o profile özel kodu belirleyip ikinci kez onaylayın; diğer kişiler de aynı adımları kendi profillerinde yapar. Kod değiştirmek için ilgili profil olarak giriş yaptıktan sonra “Giriş kodunu değiştir” düğmesini kullanın; eski kod tekrar sorulmaz. Yeni telefon veya tarayıcıda aynı profili seçip o kişinin kodunu girin.

Kod unutulursa mevcut kodla giriş gerekir; yönetici kurtarma akışı bu sürümde yoktur. 4 haneli kod basit ekip içi kapı içindir, güçlü hesap kimlik doğrulaması yerine geçmez.

## Özellikler

- **Ekip ve roller (v3):** Akif (yönetici) herkese görev atar ve Merkez üyesi ekleyebilir. Mehmet ve Uğur (Merkez) kendilerine ve Yönetim Kurulu'na görev atar, Yönetim Kurulu üyesi ekleyebilir. Yönetim Kurulu üyeleri yalnızca kendi görevlerini görür ve yalnızca kendilerine görev ekler. Kurallar sunucuda uygulanır.
- **Benim görevlerim / Ekip takibi:** Herkes önce kendi işlerini görür. Merkez, "Ekip takibi"nde herkesin işini kişi kişi, ilerleme çubuğuyla izler.
- **Pano:** Yapılacak, Devam ediyor, Beklemede, Tamamlandı sütunları. Bilgisayarda sürükle-bırak, telefonda kart üzerindeki durum menüsü.
- **Proje / etiket:** Görevlere proje adı verilir; üstteki şeritte her projenin ilerleme yüzdesi görünür, tıklayınca o projeye süzülür.
- **Ekip sayfası:** Kişi ekleme (ilk giriş kodunu ekleyen verir), kod sıfırlama, pasifleştirme. Pasif kişi giriş yapamaz, görevleri silinmez.
- **6 haneli giriş kodu:** Eski 4 haneli kodlar bir kez daha çalışır; ardından kişi 6 haneli yeni kodunu belirlemek zorundadır.

- **Görevler:** Göreve tıklayınca düzenlenir. Sorumlu (Akif, Mehmet, Uğur, Herkes), öncelik (Normal / Acil) ve son tarih seçilir. Arama ve “Bana atananlar” filtresi var. Açık görevler sırası: geciken, bugün biten ve acil olanlar üstte, sonra son tarihe göre. Kimin eklediği ve tamamladığı otomatik kaydedilir. Silinen görev 5 saniye içinde “Geri al” ile geri gelir. Klavyede `N` yeni görev açar.
- **Takvim:** Son tarihli görevler aylık ızgarada, telefonda haftalık listede görünür; renkler sorumlu kişiye göredir, gecikenler kırmızı çerçeveli, tamamlananlar soluktur. Boş güne tıklamak o tarihli yeni görev açar; bilgisayarda görev başka bir güne sürüklenebilir. “Takvime aktar” açık görevleri `.ics` dosyası olarak indirir (iPhone/Google Takvim’e tek seferlik eklenir, sonradan otomatik güncellenmez).
- **Meet:** “Meet oluştur” düğmesi (ya da `M` tuşu) tarih, saat ve isteğe bağlı Google Meet bağlantısıyla toplantı ekler. Meet’ler listede en üstte, kıpkırmızı satır ve “Katıl” düğmesiyle; takvimde saatiyle kırmızı etiket olarak görünür. `.ics` aktarımında saatli etkinlik olur ve 15 dk önce hatırlatır. Bağlantı yalnızca `https://` olabilir. Site Meet bağlantısını kendisi üretemez; formdaki “Google Meet’te yeni toplantı aç” ile açılan bağlantı kopyalanıp yapıştırılır.
- **Eşzamanlı düzenleme:** İki kişi aynı görevi aynı anda düzenlerse ikinci kayıt reddedilir, liste yenilenir ve “tekrar dene” uyarısı çıkar; kimsenin değişikliği habersizce ezilmez.

## Güvenlik notları

- **Deneme sınırı:** Bir profilde 5 hatalı koddan sonra o profil 15 dakika kilitlenir; her yeni 5 hatada süre iki katına çıkar (en fazla 24 saat). Başarılı giriş sayacı sıfırlar. Kilidi erken açmak için SQL Editor’da: `delete from public.pin_attempts where profile_id = 'akif';`
- **Oturum süresi:** 12 saat dolunca sayfa kodu tekrar ister.
- **Görev ekleme:** Yeni görev `add_task` ile yalnızca kendisi gönderilir; başkasının o sırada yaptığı değişikliklerin üzerine yazılmaz. Başlık, detay ve sorumlu uzunlukları sunucuda da denetlenir.
- **Cihazda veri yok:** Görevler ve notlar artık tarayıcıya kaydedilmez; eski sürümün bıraktığı kopyalar ilk açılışta silinir.
- **CSV raporu:** `=`, `+`, `-`, `@` ile başlayan hücreler Excel’de formül olarak çalışmasın diye başına `'` eklenir.

## Dosyalar

```
index.html                       Sayfa iskeleti
styles.css                       Stiller
app.js                           Uygulama mantığı (Supabase RPC çağrıları)
calendar.js                      Takvim sekmesi ve .ics dışa aktarma
supabase/schema.sql              İlk kurulum
supabase/security_hardening.sql  Güvenlik güncellemesi (schema.sql’den sonra)
supabase/v2_features.sql         Düzenleme, öncelik, kim yaptı, geri alma, Meet (hardening’den sonra)
supabase/v3_team.sql             Ekip, roller, pano, projeler, 6 haneli kod (v2’den sonra)
supabase/migrate_profile_pins.sql Eski ortak koddan kişisel kodlara geçiş
```

GitHub Pages dosyaları önbelleğe alır; `app.js` veya `styles.css` değişince `index.html` içindeki `?v=` numarasını artırın.

Tarayıcıda yalnızca Supabase publishable key kullanılır; service-role/secret key’i depoya koymayın.
