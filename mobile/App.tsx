// Party List for iPhone and Android.
// The list itself is the web app (same code as partylist.tuex.site) shown in a WebView.
// This native shell adds what a web page can't do inside an app:
//   - Sign in with Apple (native sheet on iPhone) and Google (system browser, as Google requires)
//   - the £2.99 lifetime unlock as an App Store / Google Play purchase (RevenueCat)
//   - sharing exported PDFs / Word files through the phone's share sheet
import 'react-native-url-polyfill/auto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StyleSheet, View, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import Constants from 'expo-constants';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Purchases from 'react-native-purchases';
import { createClient, type Session } from '@supabase/supabase-js';

SplashScreen.preventAutoHideAsync().catch(() => {});

type Extra = {
  siteUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  revenuecatIosKey?: string;
  revenuecatAndroidKey?: string;
};
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;
const SITE = extra.siteUrl.replace(/\/$/, '') + '/';
const SITE_ORIGIN = new URL(SITE).origin;
const REDIRECT = 'partylist://auth';
const ENTITLEMENT = 'premium';

const supabase = createClient(extra.supabaseUrl, extra.supabaseKey, {
  auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
});

const rcKey = Platform.OS === 'ios' ? extra.revenuecatIosKey : extra.revenuecatAndroidKey;
let purchasesReady = false;
if (rcKey) { Purchases.configure({ apiKey: rcKey }); purchasesReady = true; }

type FromWeb =
  | { type: 'signin'; provider: 'apple' | 'google' }
  | { type: 'signout' }
  | { type: 'purchase'; userId: string }
  | { type: 'restore'; userId: string }
  | { type: 'share'; filename: string; mime: string; base64: string };

export default function App() {
  const web = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const dark = useColorScheme() === 'dark';
  const bg = dark ? '#0d0d0f' : '#f7f7f8';

  // run a call on window.partyNative inside the page
  const tellWeb = useCallback((fn: string, arg: unknown) => {
    web.current?.injectJavaScript(`window.partyNative && window.partyNative.${fn}(${JSON.stringify(arg)}); true;`);
  }, []);
  const giveSession = useCallback((s: Session | null) => {
    if (s) tellWeb('onSession', { access_token: s.access_token, refresh_token: s.refresh_token });
  }, [tellWeb]);

  // Android back button goes back inside the page first
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) { web.current?.goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  async function signInApple() {
    const rawNonce = Crypto.randomUUID() + Crypto.randomUUID();
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
    if (!cred.identityToken) throw new Error('Apple didn’t return a token');
    const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.identityToken, nonce: rawNonce });
    if (error) throw error;
    return data.session;
  }

  // Google (and Apple on Android) through the system browser, then back via partylist://auth
  async function signInBrowser(provider: 'google' | 'apple') {
    const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: REDIRECT, skipBrowserRedirect: true } });
    if (error || !data.url) throw error ?? new Error('no url');
    const res = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT);
    if (res.type !== 'success') return null;
    const code = new URL(res.url).searchParams.get('code');
    if (!code) throw new Error('Sign-in was cancelled');
    const ex = await supabase.auth.exchangeCodeForSession(code);
    if (ex.error) throw ex.error;
    return ex.data.session;
  }

  async function handle(msg: FromWeb) {
    switch (msg.type) {
      case 'signin': {
        try {
          const useNativeApple = msg.provider === 'apple' && Platform.OS === 'ios' && (await AppleAuthentication.isAvailableAsync());
          const session = useNativeApple ? await signInApple() : await signInBrowser(msg.provider);
          giveSession(session);
        } catch (e: any) {
          if (e?.code === 'ERR_REQUEST_CANCELED') return;   // user closed the Apple sheet
          tellWeb('onSignInFailed', 'Sign-in didn’t work, please try again');
        }
        return;
      }
      case 'signout': {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        if (purchasesReady) await Purchases.logOut().catch(() => {});
        return;
      }
      case 'purchase': {
        if (!purchasesReady) return tellWeb('onPurchase', 'failed');
        try {
          await Purchases.logIn(msg.userId);            // purchase belongs to this Party List account
          const offerings = await Purchases.getOfferings();
          const pkg = offerings.current?.lifetime ?? offerings.current?.availablePackages[0];
          if (!pkg) return tellWeb('onPurchase', 'failed');
          await Purchases.purchasePackage(pkg);
          tellWeb('onPurchase', 'ok');
        } catch (e: any) {
          tellWeb('onPurchase', e?.userCancelled ? 'cancelled' : 'failed');
        }
        return;
      }
      case 'restore': {
        if (!purchasesReady) return tellWeb('onPurchase', 'failed');
        try {
          await Purchases.logIn(msg.userId);
          const info = await Purchases.restorePurchases();
          tellWeb('onPurchase', info.entitlements.active[ENTITLEMENT] ? 'ok' : 'nothing');
        } catch {
          tellWeb('onPurchase', 'failed');
        }
        return;
      }
      case 'share': {
        try {
          const safe = msg.filename.replace(/[^\w.\-]+/g, '-');
          const uri = FileSystem.cacheDirectory + safe;
          await FileSystem.writeAsStringAsync(uri, msg.base64, { encoding: FileSystem.EncodingType.Base64 });
          await Sharing.shareAsync(uri, { mimeType: msg.mime, dialogTitle: safe });
        } catch { /* user closed the share sheet */ }
        return;
      }
    }
  }

  const onMessage = (e: WebViewMessageEvent) => {
    try { handle(JSON.parse(e.nativeEvent.data)); } catch { /* ignore */ }
  };

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <WebView
        ref={web}
        source={{ uri: SITE }}
        style={{ backgroundColor: bg }}
        originWhitelist={['https://*', 'http://*']}
        onMessage={onMessage}
        onLoadEnd={async () => {
          SplashScreen.hideAsync().catch(() => {});
          // already signed in natively from an earlier launch? make sure the page has it
          const { data } = await supabase.auth.getSession();
          giveSession(data.session);
        }}
        onNavigationStateChange={(s) => setCanGoBack(s.canGoBack)}
        // keep the app on Party List; email, texts, phone and other sites open in their own apps
        onShouldStartLoadWithRequest={(req) => {
          if (req.url.startsWith(SITE_ORIGIN) || req.url.startsWith('about:') || req.url.startsWith('blob:') || req.url.startsWith('data:')) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        domStorageEnabled
        javaScriptEnabled
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled={false}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        applicationNameForUserAgent="PartyListApp/1.0"
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
