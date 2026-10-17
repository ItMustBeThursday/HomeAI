package ai.home.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** AES-GCM wrapping; neither credentials nor Ed25519 private material is stored in plaintext. */
final class SecureStore {
 private final SharedPreferences prefs;
 private final SecretKey key;
 SecureStore(Context context) throws Exception {
  prefs=context.getSharedPreferences("homeai_secure",Context.MODE_PRIVATE);
  KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
  String alias="homeai-device-wrapper-v1";
  if(!ks.containsAlias(alias)) {
   KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
   gen.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); gen.generateKey();
  }
  key=(SecretKey)ks.getKey(alias,null);
  importFamilyProvisioning(context);
 }
 /** Optional private-family build provisioning. Imported once, atomically;
  * never replaces an existing install or reverses an explicit Forget action. */
 private void importFamilyProvisioning(Context context)throws Exception {
  if(prefs.contains("identity")||prefs.contains("connection")||prefs.getBoolean("provisioning_imported",false))return;
  try(InputStream input=context.getAssets().open("family-connection.json")){
   ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int count;
   while((count=input.read(buffer))!=-1){if(bytes.size()+count>16384)throw new IllegalArgumentException("Family provisioning is too large");bytes.write(buffer,0,count);}
   JSONObject seed=new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
   String privateKey=seed.getString("privateKey"),deviceToken=seed.getString("deviceToken");
   if(Protocol.decode(privateKey).length!=32||deviceToken.trim().isEmpty())throw new IllegalArgumentException("Invalid family provisioning");
   String url=Protocol.validateUrl(seed.getString("url"));
   String connection=GatewayClient.obj("url",url,"deviceToken",deviceToken,"bootstrapToken","","expiresAtMs",0).toString();
   if(!prefs.edit().putString("identity",encode("identity",privateKey)).putString("connection",encode("connection",connection)).putBoolean("provisioning_imported",true).commit())throw new IllegalStateException("Could not import family connection");
  }catch(FileNotFoundException absent){/* Ordinary builds use manual pairing. */}
 }
 String get(String name) throws Exception {
  String encoded=prefs.getString(name,null); if(encoded==null)return null;
  String[] parts=encoded.split(":",2);
  Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
  cipher.updateAAD(name.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),java.nio.charset.StandardCharsets.UTF_8);
 }
 void put(String name,String value) throws Exception {
  if(value==null){prefs.edit().remove(name).commit();return;}
  if(!prefs.edit().putString(name,encode(name,value)).commit())throw new IllegalStateException("Could not save device credentials");
 }
 private String encode(String name,String value)throws Exception {
  Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key);
  cipher.updateAAD(name.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  return Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)),Base64.NO_WRAP);
 }
}
