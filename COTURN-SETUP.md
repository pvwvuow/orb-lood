# نصب و راه‌اندازی coturn (TURN Server) برای Voice Chat

## چرا coturn لازمه؟

WebRTC برای برقراری تماس صوتی بین کاربرها نیاز به STUN/TURN server داره.
سرورهای عمومی (Google, Metered, Twilio) در ایران فیلتر هستن، پس باید
روی **همون سرور خودت** یه TURN server بالا بیاری.

## نصب (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install coturn -y
```

## فعال‌سازی سرویس

```bash
# فایل /etc/default/coturn رو باز کن و این خط رو از کامنت در بیار:
# TURNSERVER_ENABLED=1
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

## تنظیمات coturn

فایل `/etc/turnserver.conf` رو ویرایش کن:

```conf
# پورت‌های اصلی
listening-port=3478
tls-listening-port=5349

# آدرس IP سرورت (عمومی)
# اگه سرورت NAT پشت خودش نیست، این خط رو بزار:
external-ip=YOUR_SERVER_PUBLIC_IP

# اگه پشت NAT هست (مثلا AWS/GCP):
# external-ip=PUBLIC_IP/PRIVATE_IP

# Realm (دامنه سرورت یا هر چیزی)
realm=your-domain.com

# اعتبارسنجی ثابت (ساده‌ترین روش)
lt-cred-mech
user=orblood:orblood

# محدوده پورت‌های relay (باز کن تو فایروال)
min-port=49152
max-port=65535

# لاگ
log-file=/var/log/turnserver.log
verbose

# TLS (اختیاری ولی پیشنهادی — از certbot استفاده کن)
# cert=/etc/letsencrypt/live/your-domain.com/fullchain.pem
# pkey=/etc/letsencrypt/live/your-domain.com/privkey.pem

# امنیت — فقط اجازه relay بده، نه ترافیک به شبکه داخلی
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

## باز کردن پورت‌ها در فایروال

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

## شروع سرویس

```bash
sudo systemctl restart coturn
sudo systemctl enable coturn
```

## تست

```bash
# چک کن سرویس اجرا شده:
sudo systemctl status coturn

# تست از بیرون (می‌تونی از https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ استفاده کنی)
```

## تنظیم در .env اپلیکیشن

فایل `server/.env` رو باز کن و اینا رو بزار:

```env
# خودکار از دامنه PUBLIC_ORIGIN استخراج میشه، ولی اگه دامنه TURN فرق داره:
TURN_HOST=your-domain.com
TURN_USERNAME=orblood
TURN_PASSWORD=orblood

# یا اگه می‌خوای دقیق URL ها رو مشخص کنی:
# TURN_URLS=turn:your-domain.com:3478,turn:your-domain.com:3478?transport=tcp,turns:your-domain.com:5349
```

## نکات مهم

1. **حتما پورت‌ها رو باز کن** — خصوصا UDP 3478 و رنج 49152-65535
2. **TLS رو فعال کن** اگه HTTPS داری — `turns:` روی پورت 443 یا 5349 از فایروال‌های سخت‌گیر رد میشه
3. **از همون سروری استفاده کن** که اپلیکیشنت روشه — اینطوری مشکل فیلترینگ نداری
4. اگه سرورت **پشت NAT** هست (AWS, GCP, etc.)، حتما `external-ip` رو ست کن
5. Username/password رو عوض کن و یه چیز قوی بزار

## بدون coturn (فقط اگه هر دو کاربر روی یه شبکه لوکال هستن)

اگه همه کاربرات توی یه شبکه محلی هستن (مثلا LAN)، حتی بدون TURN هم
WebRTC مستقیم وصل میشه. ولی برای اینترنت حتما TURN لازمه.
