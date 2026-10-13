# Unipakt Görev Masası

Akif, Mehmet ve Uğur için ortak görev listesi, tamamlanma raporu ve kişi başına yapışkan not. Arayüz GitHub Pages'te, ortak veriler Supabase'te çalışır.

## Veritabanı

Supabase SQL Editor'da `supabase/schema.sql` içeriğini çalıştırın. Bu örnek uygulama şifresiz profil seçimi kullanır; `anon` rolüne görev ve notları yönetme izni verir. Pages bağlantısını bilen herkes kayıtları okuyup değiştirebilir. Ekip dışına kapatmak için Supabase Auth ve RLS politikalarıyla üyelik kontrolü ekleyin.

The browser uses only the Supabase publishable key. Never put a secret or service-role key in this repository.
