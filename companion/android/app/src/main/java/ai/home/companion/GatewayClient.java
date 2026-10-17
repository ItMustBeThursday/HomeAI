package ai.home.companion;

import android.os.Handler;
import android.os.Looper;
import org.json.*;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import okhttp3.*;
import java.security.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;

final class GatewayClient {
 interface Listener { void status(String state); void event(String name,JSONObject data); }
 interface Reply { void done(JSONObject payload,String error); }
 private final SecureStore store;
 private final Listener listener;
 private final Handler main=new Handler(Looper.getMainLooper());
 private final OkHttpClient http=new OkHttpClient.Builder().pingInterval(20,TimeUnit.SECONDS).build();
 private final Map<String,Reply> pending=new HashMap<>();
 private WebSocket socket;
 private int generation=0,attempt=0;
 private boolean stopped=true;
 boolean connected=false;
 String url=Protocol.DEFAULT_URL;
 private String token="",bootstrap="";
 private long expires=0;
 private Ed25519PrivateKeyParameters identity;
 private String publicKey,deviceId;
 GatewayClient(SecureStore store,Listener listener) throws Exception {
  this.store=store;this.listener=listener;
  String saved=store.get("identity");
  identity=saved==null?new Ed25519PrivateKeyParameters(new SecureRandom()):new Ed25519PrivateKeyParameters(Protocol.decode(saved),0);
  if(saved==null)store.put("identity",Protocol.b64(identity.getEncoded()));
  byte[] raw=identity.generatePublicKey().getEncoded();publicKey=Protocol.b64(raw);
  byte[] digest=MessageDigest.getInstance("SHA-256").digest(raw);StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format("%02x",b));deviceId=hex.toString();
  String savedConnection=store.get("connection");
  if(savedConnection!=null){JSONObject c=new JSONObject(savedConnection);url=c.optString("url",url);token=c.optString("deviceToken");bootstrap=c.optString("bootstrapToken");expires=c.optLong("expiresAtMs");}
 }
 static JSONObject obj(Object... values){JSONObject o=new JSONObject();try{for(int i=0;i<values.length;i+=2)o.put((String)values[i],values[i+1]);}catch(JSONException e){throw new IllegalArgumentException(e);}return o;}
 void pair(String code,String address) throws Exception {
  JSONObject c=new JSONObject(new String(Protocol.decode(code.trim()),StandardCharsets.UTF_8));
  String fresh=c.getString("bootstrapToken");long expiry=c.optLong("expiresAtMs");
  if(fresh.trim().isEmpty()||(expiry>0&&expiry<=System.currentTimeMillis()))throw new IllegalArgumentException("Setup code is empty or expired. Generate a new limited setup code.");
  String newUrl=Protocol.validateUrl(address.trim().isEmpty()?c.getString("url"):address);
  stop();url=newUrl;token="";bootstrap=fresh;expires=expiry;save();start();
 }
 void updateAddress(String address)throws Exception{String safe=Protocol.validateUrl(address);if(!safe.equals(url)&&(!token.isEmpty()||!bootstrap.isEmpty()))throw new IllegalArgumentException("Forget pairing before changing the server address.");url=safe;save();start();}
 void forget()throws Exception{stop();token="";bootstrap="";expires=0;store.put("connection",null);listener.status("Not paired");}
 private void save()throws Exception{store.put("connection",obj("url",url,"deviceToken",token,"bootstrapToken",bootstrap,"expiresAtMs",expires).toString());}
 void start(){stopped=false;connect();}
 void stop(){stopped=true;generation++;connected=false;if(socket!=null)socket.cancel();socket=null;failPending("Connection closed");}
 private void failPending(String error){List<Reply> copy=new ArrayList<>(pending.values());pending.clear();for(Reply r:copy)r.done(null,error);}
 private void connect(){
  if(stopped)return;
  if(token.isEmpty()&&bootstrap.isEmpty()){listener.status("Pair this device in Settings");return;}
  if(token.isEmpty()&&expires>0&&expires<=System.currentTimeMillis()){listener.status("Setup code expired — pair again");return;}
  int gen=++generation;connected=false;if(socket!=null)socket.cancel();failPending("Reconnecting");
  try{Protocol.validateUrl(url);}catch(Exception e){listener.status(e.getMessage());return;}
  listener.status("Connecting…");
  socket=http.newWebSocket(new Request.Builder().url(url).build(),new WebSocketListener(){
   public void onMessage(WebSocket ws,String text){main.post(()->{if(gen!=generation)return;try{frame(new JSONObject(text));}catch(Exception e){listener.status("Invalid server response");}});}
   public void onClosing(WebSocket ws,int code,String reason){ws.close(code,reason);}
   public void onClosed(WebSocket ws,int code,String reason){main.post(()->disconnected(gen));}
   public void onFailure(WebSocket ws,Throwable t,Response response){main.post(()->disconnected(gen));}
  });
 }
 private void disconnected(int gen){if(gen!=generation||stopped)return;connected=false;failPending("Connection lost");listener.status("Offline · reconnecting…");int wait=Math.min(30000,1000*(1<<Math.min(attempt++,5)));main.postDelayed(()->{if(gen==generation&&!stopped)connect();},wait);}
 void request(String method,JSONObject params,Reply reply){if(!connected){reply.done(null,"Not connected");return;}raw(method,params,reply);}
 private void raw(String method,JSONObject params,Reply reply){String id=UUID.randomUUID().toString();pending.put(id,reply);if(socket==null||!socket.send(obj("type","req","id",id,"method",method,"params",params).toString())){pending.remove(id);reply.done(null,"Could not send request");return;}main.postDelayed(()->{Reply r=pending.remove(id);if(r!=null)r.done(null,"Request timed out; check history before retrying");},60000);}
 private void frame(JSONObject f)throws Exception {
  if("res".equals(f.optString("type"))){Reply r=pending.remove(f.optString("id"));if(r!=null){JSONObject error=f.optJSONObject("error");r.done(f,f.optBoolean("ok")?null:error==null?"Request failed":error.optString("message","Request failed"));}return;}
  if(!"event".equals(f.optString("type")))return;
  String name=f.optString("event");JSONObject p=f.optJSONObject("payload");if(p==null)p=new JSONObject();
  if("connect.challenge".equals(name))handshake(p);else listener.event(name,p);
 }
 private void handshake(JSONObject challenge)throws Exception {
  long ts=challenge.getLong("ts");String nonce=challenge.getString("nonce");
  Protocol.ConnectProof proof=new Protocol.ConnectProof(deviceId,token,bootstrap,ts,nonce);
  boolean boot=proof.bootstrap;String role=proof.role,mode=proof.mode;
  JSONArray scopes=boot?new JSONArray():new JSONArray(Arrays.asList(proof.scopes.split(",")));
  String payload=proof.payload;
  Ed25519Signer signer=new Ed25519Signer();signer.init(true,identity);byte[] bytes=payload.getBytes(StandardCharsets.UTF_8);signer.update(bytes,0,bytes.length);
  JSONObject params=obj("minProtocol",4,"maxProtocol",4,"client",obj("id","openclaw-android","version",BuildConfig.VERSION_NAME,"platform","android","mode",mode,"deviceFamily","android"),"role",role,"scopes",scopes,"caps",new JSONArray(),"commands",new JSONArray(),"permissions",new JSONObject(),"auth",boot?obj("bootstrapToken",proof.credential):obj("token",proof.credential),"locale",Locale.getDefault().toLanguageTag(),"userAgent","homeai-android/"+BuildConfig.VERSION_NAME,"device",obj("id",deviceId,"publicKey",publicKey,"signature",Protocol.b64(signer.generateSignature()),"signedAt",ts,"nonce",nonce));
  raw("connect",params,(response,error)->{
   if(error!=null){JSONObject err=response==null?null:response.optJSONObject("error");JSONObject detail=err==null?null:err.optJSONObject("details");String code=detail==null?"":detail.optString("code");if("PAIRING_REQUIRED".equals(code)||(err!=null&&"NOT_PAIRED".equals(err.optString("code")))){listener.status("Waiting for device approval"+(detail==null?"":" · "+detail.optString("requestId")));int gen=generation;main.postDelayed(()->{if(gen==generation&&!stopped)connect();},5000);}else{stop();listener.status("Pairing/authentication failed: "+error);}return;}
   try{
    JSONObject hello=response.getJSONObject("payload"),auth=hello.optJSONObject("auth");
    if(boot){JSONArray tokens=auth==null?null:auth.optJSONArray("deviceTokens");String issued="";if(tokens!=null)for(int i=0;i<tokens.length();i++){JSONObject t=tokens.getJSONObject(i);if("operator".equals(t.optString("role")))issued=t.optString("deviceToken");}if(issued.isEmpty())throw new IllegalStateException("No operator token issued; generate a limited setup code");token=issued;bootstrap="";expires=0;save();connect();return;}
    if(auth!=null&&!auth.optString("deviceToken").isEmpty()){token=auth.optString("deviceToken");save();}
    connected=true;attempt=0;listener.status("Connected securely");raw("sessions.subscribe",new JSONObject(),(r,e)->{});listener.event("ready",hello);
   }catch(Exception e){stop();listener.status(e.getMessage());}
  });
 }
}
