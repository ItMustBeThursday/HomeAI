package ai.home.companion;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.Locale;
import java.util.function.Consumer;

/** Opt-in platform read-aloud, not a microphone or conversational voice session. */
final class ReadAloud {
 private final Handler main=new Handler(Looper.getMainLooper());
 private final Consumer<Boolean> state;
 private final Consumer<String> error;
 private TextToSpeech engine;
 private boolean ready=false,closed=false;
 private String remaining="",currentId="";
 private long sequence=0;

 ReadAloud(Context context,Consumer<Boolean> state,Consumer<String> error){
  this.state=state;this.error=error;
  engine=new TextToSpeech(context.getApplicationContext(),result->main.post(()->{
   if(closed)return;
   if(result!=TextToSpeech.SUCCESS)return;
   int language=engine.setLanguage(Locale.getDefault());
   ready=language!=TextToSpeech.LANG_MISSING_DATA&&language!=TextToSpeech.LANG_NOT_SUPPORTED;
  }));
  engine.setOnUtteranceProgressListener(new UtteranceProgressListener(){
   public void onStart(String id){}
   public void onDone(String id){main.post(()->{if(!closed&&id.equals(currentId))next();});}
   @Deprecated public void onError(String id){main.post(()->{if(!closed&&id.equals(currentId)){stop();error.accept("Could not read this response aloud. Check your device voice settings.");}});}
  });
 }
 void speak(String text){
  stop();if(closed||text==null||text.trim().isEmpty())return;
  if(!ready){error.accept("Voice is not ready. Try again after checking your device text-to-speech settings.");return;}
  remaining=text.trim();state.accept(true);next();
 }
 private void next(){
  if(remaining.isEmpty()){currentId="";state.accept(false);return;}
  int end=Math.min(remaining.length(),Math.min(3000,TextToSpeech.getMaxSpeechInputLength()));
  if(end<remaining.length()&&Character.isHighSurrogate(remaining.charAt(end-1)))end--;
  String chunk=remaining.substring(0,end);remaining=remaining.substring(end);
  currentId="homeai-read-"+(++sequence);
  if(engine.speak(chunk,TextToSpeech.QUEUE_FLUSH,new Bundle(),currentId)==TextToSpeech.ERROR){stop();error.accept("Could not start read aloud. Check your device voice settings.");}
 }
 void stop(){remaining="";currentId="";engine.stop();state.accept(false);}
 void close(){closed=true;stop();engine.shutdown();}
}
