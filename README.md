# Unipakt Görev Masası

Akif, Mehmet ve Uğur için ortak görev listesi, tamamlanma raporu ve kişi başına yapışkan not. Arayüz GitHub Pages’te, ortak veriler Supabase’te çalışır.

## Supabase kurulumu

Yeni kurulumda Supabase SQL Editor’da `supabase/schema.sql` dosyasını çalıştırın. Önceki ortak kod kurulumunu yaptıysanız, kişi başına ayrı kodlara geçmek için `supabase/migrate_profile_pins.sql` dosyasını çalıştırın. Görev ve not tablolarına doğrudan anonim erişim kapalıdır. Her profilin 4 haneli kodu ayrı ayrı Supabase’te bcrypt özeti olarak saklanır. Başarılı giriş 12 saatlik geçici oturum açar; oturum anahtarı tarayıcı depolamasına yazılmaz. Not işlemleri yalnızca giriş yapan profilin notuna izin verir.

Önce kendi profilinizi seçin. İlk kullanımda o profile özel kodu belirleyip ikinci kez onaylayın; diğer kişiler de aynı adımları kendi profillerinde yapar. Kod değiştirmek için ilgili profil olarak giriş yaptıktan sonra “Giriş kodunu değiştir” düğmesini kullanın; eski kod tekrar sorulmaz. Yeni telefon veya tarayıcıda aynı profili seçip o kişinin kodunu girin.

Kod unutulursa mevcut kodla giriş gerekir; yönetici kurtarma akışı bu sürümde yoktur. 4 haneli kod basit ekip içi kapı içindir, güçlü hesap kimlik doğrulaması yerine geçmez.

Tarayıcıda yalnızca Supabase publishable key kullanılır; service-role/secret key’i depoya koymayın.
