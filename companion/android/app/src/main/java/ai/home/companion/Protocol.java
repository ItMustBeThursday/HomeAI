package ai.home.companion;

import java.net.URI;
import java.util.Base64;

final class Protocol {
 static final String DEFAULT_URL="wss://coolermaster.tailbeae5b.ts.net:8443/companion";
 static String validateUrl(String raw) {
  URI uri=URI.create(raw.trim());
  if(!"wss".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getFragment()!=null||uri.getQuery()!=null)
   throw new IllegalArgumentException("Use a secure wss:// address without credentials, query or fragment.");
  return uri.toString();
 }
 static String b64(byte[] data){return Base64.getUrlEncoder().withoutPadding().encodeToString(data);}
 static byte[] decode(String text){return Base64.getUrlDecoder().decode(text);}
 /** One source of truth for both connect.auth and the signed proof. Bootstrap
  * credentials are signed too (Gateway resolveSignatureToken); an empty token
  * produces DEVICE_AUTH_SIGNATURE_INVALID before pairing can be considered. */
 static final class ConnectProof {
  final boolean bootstrap;
  final String role,mode,scopes,credential,payload;
  ConnectProof(String id,String deviceToken,String bootstrapToken,long ts,String nonce){
   bootstrap=deviceToken.isEmpty();role=bootstrap?"node":"operator";mode=bootstrap?"node":"ui";
   scopes=bootstrap?"":"operator.read,operator.write,operator.approvals";
   credential=bootstrap?bootstrapToken:deviceToken;
   if(credential.isEmpty())throw new IllegalArgumentException("Pair this device before connecting.");
   payload=signaturePayload(id,mode,role,scopes,ts,credential,nonce);
  }
 }
 static String signaturePayload(String id,String mode,String role,String scopes,long ts,String token,String nonce){
  return String.join("|","v3",id,"openclaw-android",mode,role,scopes,Long.toString(ts),token,nonce,"android","android");
 }
}
