# نصب و راه‌اندازی coturn (TURN Server) برای Voice Chat

## چرا coturn لازمه؟

WebRTC برای برقراری تماس صوتی بین کاربرها نیاز به STUN/TURN server داره.
سرورهای عمومی (Google, Metered, Twilio) در ایران فیلتر هستن، پس باید
روی **همون سرور خودت** یه TURN server بالا بیاری.

## معماری دو-instance‌ای (پیشنهادی برای production در ایران)

این repo برای **دو instance همزمان** coturn کانفیگ شده:

| Instance | Config file | Systemd unit | پورت‌ها | کاربرد |
|----------|-------------|--------------|--------|--------|
| #1 (پیش‌فرض پکیج) | `/etc/turnserver.conf` | `coturn.service` | 3478 + 5349 | کاربرای DSL/فیبر/شبکه‌های باز |
| #2 (پورت 443) | `/etc/turnserver-443.conf` | `coturn-443.service` | 443 (TCP+UDP+TLS) | کاربرای موبایل ایرانسل/همراه اول |

### چرا دو تا instance؟

- یه پروسه‌ی coturn نمی‌تونه روی یه پورت هم plain و هم TLS سرو کنه به طور قابل اطمینان (مخصوصاً وقتی پورت :443 ـه).
- اپراتورهای موبایل ایران معمولاً UDP/3478 و TCP/3478 رو می‌بندن، ولی :443 هیچ‌وقت بسته نمیشه چون HTTPS رو می‌شکنه.
- وقتی coturn روی :443 می‌شینه، ترافیک TURN از deep packet inspection فرق نکنه از HTTPS عادی، پس از فیلترینگ رد میشه.

> ⚠️ این یعنی **nginx نباید روی `0.0.0.0:443` گوش بده**. روی orblood.ir سایت پشت ArvanCloud CDN هست و TLS رو خود Arvan terminate می‌کنه؛ nginx فقط روی :80 هست (برای ACME و proxy)، و :443 آزاد می‌مونه برای coturn.

## نصب پکیج

```bash
sudo apt update
sudo apt install coturn -y

# instance پیش‌فرض رو فعال کن:
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

## نصب کانفیگ‌ها

از root این repo (مثلاً `/opt/orblood`):

```bash
# Instance #1 (3478 + 5349)
sudo cp turnserver.conf /etc/turnserver.conf

# Instance #2 (443)
sudo cp turnserver-443.conf /etc/turnserver-443.conf
sudo cp coturn-443.service /etc/systemd/system/coturn-443.service

# قبل از start: فایل‌های log رو با مالکیت درست بساز
sudo touch /var/log/turnserver.log /var/log/turnserver-443.log
sudo chown turnserver:turnserver /var/log/turnserver.log /var/log/turnserver-443.log
sudo chmod 640 /var/log/turnserver.log /var/log/turnserver-443.log
```

## مقدارها رو با محیط خودت تنظیم کن

تو هر دو فایل `turnserver.conf` و `turnserver-443.conf`:

1. `external-ip=` — IP عمومی VPSت (با `curl ifconfig.me`)
2. `realm=` — معمولاً `turn.your-domain.com`
3. `user=` — `<username>:<password>`
4. `cert=` و `pkey=` — مسیر سرتیفیکیت Let's Encrypt برای دامنه‌ی turn

و بعد توی `server/.env` همون مقادیر رو ست کن:

```env
TURN_HOST=turn.your-domain.com
TURN_USERNAME=orblood
TURN_PASSWORD=<EXACTLY_THE_SAME_PASSWORD_AS_user=_LINE>
TURN_URLS=turns:turn.your-domain.com:443?transport=tcp,turn:turn.your-domain.com:443?transport=tcp,turn:turn.your-domain.com:443?transport=udp,turns:turn.your-domain.com:5349?transport=tcp,turn:turn.your-domain.com:3478?transport=udp,turn:turn.your-domain.com:3478?transport=tcp
VOICE_FORCE_RELAY=true
```

> ⚠️ پسورد توی `.env` و `user=` تو هر دو conf باید **بایت به بایت یکی باشن**. ناهماهنگی، هر Allocate رو silent reject می‌کنه و کاربر فقط 30-40 ثانیه timeout می‌بینه.

## DNS

یه subdomain جدا برای TURN بساز که **ابرش خاموش (CDN bypass)** باشه:

| Type | Name | Value | Cloud/Proxy |
|------|------|-------|-------------|
| A    | turn | 194.60.231.226 (IP خودت) | **OFF** |

اگه `turn.*` رو از CDN رد کنی، CDN روی :443 TLS handshake رو می‌خوره و TURN کار نمی‌کنه.

## فایروال

```bash
# پورت‌های signaling
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp

# رنج relay (اون چیزی که min-port/max-port تو conf گفتیم)
sudo ufw allow 49152:65535/udp
```

## Start کردن سرویس‌ها

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coturn coturn-443

# تأیید
sudo systemctl status coturn coturn-443 --no-pager | head -30
sudo ss -tlnp | grep -E ':443|:3478|:5349'
sudo ss -ulnp | grep -E ':443|:3478|:5349'
```

باید دو پروسه‌ی turnserver ببینی که با هم روی پورت‌های مختلف listening می‌کنن.

## تست

### از خود سرور

```bash
# با credential واقعی tested روی پورت‌های مختلف
turnutils_uclient -u orblood -w '<TURN_PASSWORD>' -p 3478 -e 1.1.1.1 turn.your-domain.com
turnutils_uclient -u orblood -w '<TURN_PASSWORD>' -p 443  -e 1.1.1.1 turn.your-domain.com
turnutils_uclient -u orblood -w '<TURN_PASSWORD>' -p 443 -t -e 1.1.1.1 turn.your-domain.com
turnutils_uclient -u orblood -w '<TURN_PASSWORD>' -p 443 -t -S -e 1.1.1.1 turn.your-domain.com
turnutils_uclient -u orblood -w '<TURN_PASSWORD>' -p 5349 -t -S -e 1.1.1.1 turn.your-domain.com
```

اگه لاگ `Allocation` ببینی موفقیت‌آمیز هست. پیام `403 (Forbidden IP)` با peer داخلی (مثل `127.0.0.1` یا IP عمومی خود سرور تو لیست `denied-peer-ip`) **علامت سلامتی** ـه — یعنی auth + allocate کار کرد، فقط peer رد شد.

### از مرورگر

```
https://your-domain.com/voice-debug.html?nocache=1
```

و دکمه **FULL DIAGNOSTIC RUN** رو بزن. باید relay candidate (نوع `relay`) از IP عمومی سرورت ببینی، در کمتر از ۵۰۰ms.

## پیدا کردن مشکلات معمول

### کاربر فقط timeout می‌بینه، هیچ خطایی تو browser console نیست

- **اول**: لاگ `journalctl -u orblood` و `tail -f /var/log/turnserver*.log` رو بذار باز
- معمولاً علتش mismatch بین `TURN_PASSWORD` تو `.env` و `user=` تو conf هست
- یا `external-ip` غلطه (با IP عمومی واقعی check کن)

### `ERROR: Cannot open log file for writing`

کاربر `turnserver` به فایل log دسترسی نداره. fix:

```bash
sudo touch /var/log/turnserver.log
sudo chown turnserver:turnserver /var/log/turnserver.log
sudo chmod 640 /var/log/turnserver.log
sudo systemctl restart coturn
```

### `voice-debug.html` فقط 2 ICE entry نشون میده

این **درسته**! `voice-config.js` فقط دو تا entry برمی‌گردونه:
1. یه TURN entry با همه‌ی URL ها
2. یه STUN entry با همه‌ی URL ها

تعداد URL ها نباید با تعداد entry ها قاطی بشه. هر entry می‌تونه چندتا URL داشته باشه و مرورگر همه‌شون رو موازی می‌زنه.

### Cert TLS

از `certbot --nginx -d turn.your-domain.com` استفاده کن. coturn فایل cert رو با reload می‌خونه:

```bash
sudo systemctl reload coturn coturn-443
```

## نکات مهم

1. **حتما هر دو instance رو بالا نگه دار** — فقط :3478 برای کاربرای موبایل ایرانی کافی نیست
2. **Cert رو هر ۹۰ روز renew کن** (certbot timer خودش این کار رو می‌کنه)
3. **`min-port`-`max-port` رو روی هر دو instance یکی نگه دار** — coturn روی همه‌ی ports relay رو share می‌کنه
4. اگه سرورت **پشت NAT** هست (AWS, GCP, etc.)، حتما `external-ip=PUBLIC/PRIVATE` ست کن
