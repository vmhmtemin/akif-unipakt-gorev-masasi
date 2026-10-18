# Unipakt Görev Masası

Akif, Mehmet ve Uğur için ortak görev listesi, tamamlanma raporu ve kişi başına yapışkan not. Arayüz GitHub Pages’te, ortak veriler Supabase’te çalışır.

## Supabase kurulumu

Yeni kurulumda Supabase SQL Editor’da önce `supabase/schema.sql`, ardından `supabase/security_hardening.sql` dosyasını çalıştırın. Mevcut kurulumda yalnızca `supabase/security_hardening.sql` dosyasını bir kez çalıştırmanız yeterli (veriler korunur, tekrar çalıştırmak zararsızdır). Önceki ortak kod kurulumunu yaptıysanız, kişi başına ayrı kodlara geçmek için `supabase/migrate_profile_pins.sql` dosyasını çalıştırın. Görev ve not tablolarına doğrudan anonim erişim kapalıdır. Her profilin 4 haneli kodu ayrı ayrı Supabase’te bcrypt özeti olarak saklanır. Başarılı giriş 12 saatlik geçici oturum açar; oturum anahtarı tarayıcı depolamasına yazılmaz. Not işlemleri yalnızca giriş yapan profilin notuna izin verir.

Önce kendi profilinizi seçin. İlk kullanımda o profile özel kodu belirleyip ikinci kez onaylayın; diğer kişiler de aynı adımları kendi profillerinde yapar. Kod değiştirmek için ilgili profil olarak giriş yaptıktan sonra “Giriş kodunu değiştir” düğmesini kullanın; eski kod tekrar sorulmaz. Yeni telefon veya tarayıcıda aynı profili seçip o kişinin kodunu girin.

Kod unutulursa mevcut kodla giriş gerekir; yönetici kurtarma akışı bu sürümde yoktur. 4 haneli kod basit ekip içi kapı içindir, güçlü hesap kimlik doğrulaması yerine geçmez.

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
supabase/schema.sql              İlk kurulum
supabase/security_hardening.sql  Güvenlik güncellemesi (schema.sql’den sonra)
supabase/migrate_profile_pins.sql Eski ortak koddan kişisel kodlara geçiş
```

GitHub Pages dosyaları önbelleğe alır; `app.js` veya `styles.css` değişince `index.html` içindeki `?v=` numarasını artırın.

Tarayıcıda yalnızca Supabase publishable key kullanılır; service-role/secret key’i depoya koymayın.
