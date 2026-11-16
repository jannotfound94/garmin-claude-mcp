package pl.janek.garda;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * Domyślny BridgeActivity zamyka aplikację przy każdym przycisku "wstecz" (bez wtyczki @capacitor/app nie cofa historii).
 * Tutaj "wstecz" cofa historię WebView (mapa trasy → plan), a dopiero na ekranie startowym chowa aplikację.
 * Pobrania (plik GPX) przekazujemy przeglądarce telefonu, bo WebView sam ich nie obsługuje.
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
                if (wv != null && wv.canGoBack()) {
                  wv.goBack();
                } else {
                  moveTaskToBack(true);
                }
              }
            });
    WebView wv = bridge != null ? bridge.getWebView() : null;
    if (wv != null) {
      wv.setDownloadListener(
          (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
              startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
              // brak aplikacji do obsługi pliku
            }
          });
    }
  }
}
