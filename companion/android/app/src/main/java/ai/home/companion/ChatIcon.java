package ai.home.companion;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;
/** Density-independent controls, not font glyphs. */
final class ChatIcon extends View {
 private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);private String name;private int color;
 ChatIcon(Context context,String name,int color,String label,Runnable action){super(context);this.name=name;this.color=color;setContentDescription(label);setFocusable(true);setClickable(true);setOnClickListener(v->action.run());}
 void setIcon(String value,int tint,String label){name=value;color=tint;setContentDescription(label);invalidate();}
 private void line(Canvas c,float... points){Path p=new Path();p.moveTo(points[0],points[1]);for(int i=2;i<points.length;i+=2)p.lineTo(points[i],points[i+1]);c.drawPath(p,paint);}
 @Override protected void onDraw(Canvas c){super.onDraw(c);c.save();float size=Math.min(getWidth(),getHeight())*.5f;c.translate((getWidth()-size)/2,(getHeight()-size)/2);c.scale(size/24,size/24);paint.setColor(color);paint.setStrokeWidth(1.8f);paint.setStyle(Paint.Style.STROKE);paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeJoin(Paint.Join.ROUND);
 switch(name){
 case "menu":line(c,4,8,20,8);line(c,4,15,14,15);break;
 case "new":line(c,11,5,5,5,5,20,20,20,20,13);line(c,10,14,11,10,19,2,22,5,14,13,10,14);break;
 case "more":paint.setStyle(Paint.Style.FILL);for(int x=5;x<=19;x+=7)c.drawCircle(x,12,1.5f,paint);break;
 case "down":line(c,7,10,12,15,17,10);break;
 case "plus":line(c,12,4,12,20);line(c,4,12,20,12);break;
 case "up":line(c,12,20,12,4);line(c,5,11,12,4,19,11);break;
 case "stop":paint.setStyle(Paint.Style.FILL);c.drawRoundRect(6,6,18,18,2,2,paint);break;
 case "mic":c.drawRoundRect(9,3,15,14,3,3,paint);c.drawArc(6,7,18,18,0,180,false,paint);line(c,12,18,12,22);break;
 case "search":c.drawCircle(10,10,6,paint);line(c,15,15,21,21);break;
 case "close":line(c,6,6,18,18);line(c,18,6,6,18);break;
 case "settings":c.drawCircle(12,12,3,paint);for(int i=0;i<8;i++){c.save();c.rotate(i*45,12,12);line(c,12,2,12,5);c.restore();}c.drawCircle(12,12,8,paint);break;
 case "copy":c.drawRoundRect(8,7,21,21,2,2,paint);line(c,16,3,4,3,4,16);break;
 }c.restore();}
}
