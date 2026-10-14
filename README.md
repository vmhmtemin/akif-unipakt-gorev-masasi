# Unipakt Görev Masası

Akif, Mehmet ve Uğur için ortak görev listesi, tamamlanma raporu ve kişi başına yapışkan not. Arayüz GitHub Pages’te, ortak veriler Supabase’te çalışır.

## Supabase kurulumu

Supabase SQL Editor’da `supabase/schema.sql` dosyasını bir kez çalıştırın. Bu kurulum görev ve not tablolarına doğrudan anonim erişimi kapatır. Uygulama, 4 haneli kodu Supabase’te bcrypt özeti olarak saklar ve PIN doğrulamasından sonra 12 saatlik geçici oturumla verileri okur/yazar. Oturum anahtarı tarayıcı depolamasına yazılmaz.

İlk açılışta kodu belirleyip ikinci kez onaylayın. Kod değiştirmek için giriş yaptıktan sonra profil ekranındaki “Giriş kodunu değiştir” düğmesini kullanın; eski kod tekrar sorulmaz. Yeni telefon veya tarayıcıda aynı ortak kodu girin.

Kod unutulursa mevcut kodla giriş gerekir; yönetici kurtarma akışı bu sürümde yoktur. 4 haneli kod basit ekip içi kapı içindir, güçlü hesap kimlik doğrulaması yerine geçmez.

Tarayıcıda yalnızca Supabase publishable key kullanılır; service-role/secret key’i depoya koymayın.
