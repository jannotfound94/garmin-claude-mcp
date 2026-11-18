package pl.janek.garda;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Domyślny BridgeActivity zamyka aplikację przy każdym przycisku "wstecz" (bez wtyczki @capacitor/app nie cofa historii).
 * Tutaj "wstecz" najpierw zamyka otwarte okno aplikacji, potem cofa historię WebView (mapa trasy → plan), a dopiero na
 * pierwszym ekranie chowa aplikację.
 * Plik GPX z trasy nie jest "pobierany" do katalogu Pobrane: trafia do pamięci podręcznej i od razu otwiera się
 * systemowa lista aplikacji (Garmin Connect, Locus, OsmAnd...), z której Jan wybiera, gdzie go otworzyć.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getOnBackPressedDispatcher()
        .addCallback(
            this,
            new OnBackPressedCallback(true) {
              @Override
              public void handleOnBackPressed() {
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (wv == null) {
                  moveTaskToBack(true);
                  return;
                }
                // Najpierw strona: otwarte okno (np. dodawanie posiłku) zamyka sama aplikacja (window.gardaBack).
                wv.evaluateJavascript(
                    "(function(){try{return !!(window.gardaBack&&window.gardaBack());}catch(e){return false;}})()",
                    handled -> {
                      if ("true".equals(handled)) return;
                      // Cofamy przez history.back(), nie wv.goBack(): WebView pomija w goBack() wpisy historii dodane bez
                      // dotknięcia ekranu i wtedy "wstecz" przeskakiwał ekran albo zamykał aplikację.
                      if (wv.copyBackForwardList().getCurrentIndex() > 0) {
                        wv.evaluateJavascript("history.back()", null);
                      } else {
                        moveTaskToBack(true);
                      }
                    });
              }
            });
    final WebView wv = bridge != null ? bridge.getWebView() : null;
    if (bridge != null) {
      // Kliknięcie linku do pliku GPX przechwytujemy przy samej nawigacji (pewniejsze niż czekanie na "pobieranie" w WebView),
      // a wszystko inne obsługuje domyślny klient Capacitora.
      bridge.setWebViewClient(
          new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
              Uri u = request.getUrl();
              String path = u.getPath() == null ? "" : u.getPath().toLowerCase();
              if (path.endsWith(".gpx")) {
                handleDownload(view, u.toString(), "application/gpx+xml");
                return true;
              }
              return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
              super.onPageFinished(view, url);
              // Znacznik dla strony: ta wersja aplikacji sama otwiera pliki GPX (starsza nie umiała i strona prosi o aktualizację).
              view.evaluateJavascript("window.gardaNative=2", null);
            }
          });
    }
    if (wv != null) {
      wv.setDownloadListener(
          (url, userAgent, contentDisposition, mimeType, contentLength) -> handleDownload(wv, url, mimeType));
    }
  }

  private void handleDownload(WebView wv, String url, String mimeType) {
    Uri u = Uri.parse(url);
    String page = wv.getUrl();
    boolean sameHost = page != null && u.getHost() != null && u.getHost().equals(Uri.parse(page).getHost());
    boolean gpx = url.toLowerCase().contains(".gpx") || (mimeType != null && mimeType.contains("gpx"));
    if (!gpx || !sameHost || !"https".equals(u.getScheme())) {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, u));
      } catch (Exception ignored) {
        // brak aplikacji do obsługi pliku
      }
      return;
    }
    runOnUiThread(() -> Toast.makeText(this, "Przygotowuję trasę…", Toast.LENGTH_SHORT).show());
    new Thread(
            () -> {
              try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                File dir = new File(getCacheDir(), "gpx");
                dir.mkdirs();
                String last = u.getLastPathSegment() == null ? "trasa.gpx" : u.getLastPathSegment();
                File f = new File(dir, "trasa-" + last.replaceAll("[^A-Za-z0-9._-]", "_"));
                try (InputStream in = c.getInputStream();
                    FileOutputStream out = new FileOutputStream(f)) {
                  byte[] buf = new byte[8192];
                  int n;
                  while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                Uri content = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
                runOnUiThread(() -> openWithChooser(content));
              } catch (Exception e) {
                runOnUiThread(
                    () -> Toast.makeText(this, "Nie udało się pobrać trasy. Sprawdź połączenie.", Toast.LENGTH_LONG).show());
              }
            })
        .start();
  }

  private void openWithChooser(Uri content) {
    Intent view = new Intent(Intent.ACTION_VIEW);
    view.setDataAndType(content, "application/gpx+xml");
    view.setClipData(ClipData.newRawUri("trasa", content));
    view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    // Obok aplikacji, które "otwierają" plik GPX, pokazujemy też te, które przyjmują go jako udostępnienie (np. Garmin Connect, Dysk, komunikatory).
    Intent send = new Intent(Intent.ACTION_SEND);
    send.setType("application/gpx+xml");
    send.putExtra(Intent.EXTRA_STREAM, content);
    send.setClipData(ClipData.newRawUri("trasa", content));
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    Intent chooser = Intent.createChooser(view, "Otwórz trasę w aplikacji");
    chooser.putExtra(Intent.EXTRA_ALTERNATE_INTENTS, new Intent[] {send});
    chooser.setClipData(ClipData.newRawUri("trasa", content));
    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try {
      startActivity(chooser);
    } catch (Exception e) {
      Toast.makeText(this, "Brak aplikacji do otwarcia pliku GPX.", Toast.LENGTH_LONG).show();
    }
  }
}
