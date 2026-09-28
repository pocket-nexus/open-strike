/* Test-only iOS 6 UIKit event sender, never linked into the application.
 * iOS 6 uses a 28-byte path stride (GSEventGetPathInfoAtIndex); older
 * 24-byte headers deliver only the first finger. Hand type 5 changes contacts.
 * Input: delay_ms count (identity logical_x logical_y down) repeated count times.
 * All active contacts, plus contacts released at this step, must be present.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
typedef struct { float x,y; } Point;
typedef struct { int type,subtype; Point location,windowLocation; int context; uint64_t time; void *window; unsigned flags,pid; int size; } Record;
typedef struct { int type; short dx,dy; float a,b,width,c,height,d; unsigned char e,count; unsigned short x52; } Hand;
typedef struct { unsigned char index,identity,proximity; float pressure,radius; Point location; void *window; unsigned extra; } Path;
_Static_assert(sizeof(Record)==52 && sizeof(Hand)==36 && sizeof(Path)==28, "iOS 6 ARMv7 GSEvent layout");
int main(void) {
 void *lib=dlopen("/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices",RTLD_NOW);
 unsigned (*port)(const char*)=dlsym(lib,"GSCopyPurpleNamedPort");
 uint64_t (*now)(void)=dlsym(lib,"GSCurrentEventTimestamp");
 void (*send)(void*,unsigned)=dlsym(lib,"GSSendEvent");
 if(!port||!now||!send)return 3;
 unsigned target=port("dev.pocket-stack.openstrike.ipod"); if(!target)return 4;
 unsigned previous=0;int delay,count,steps=0;
 while(scanf("%d %d",&delay,&count)==2) {
  if(delay<0||delay>30000||count<1||count>8||++steps>10000)return 2;
  struct {Record record;Hand hand;Path paths[8];} e;memset(&e,0,sizeof e);
  unsigned active=0,seen=0;
  for(int i=0;i<count;i++) {
   int id,down;float x,y;
   if(scanf("%d %f %f %d",&id,&x,&y,&down)!=4||id<0||id>7||!(x>=0&&x<480)||!(y>=0&&y<320)||(down!=0&&down!=1)||seen&(1u<<id))return 2;
   seen|=1u<<id;if(down)active|=1u<<id;
   Path *p=&e.paths[i];p->index=id+1;p->identity=id+2;p->proximity=down?3:0;
   p->pressure=1;p->radius=1;
   p->location=(Point){320-y,x}; /* inverse of the host's landscape view transform */
  }
  if((previous&seen)!=previous)return 2;
  usleep(delay*1000);
  e.record.type=3001;
  for(int i=0;i<count;i++) { e.record.location.x+=e.paths[i].location.x/count; e.record.location.y+=e.paths[i].location.y/count; }
  e.record.windowLocation=e.record.location;
  e.record.time=now();e.record.size=sizeof(Hand)+count*sizeof(Path);
  e.hand.type=!previous?1:!active?6:active!=previous?5:2;
  e.hand.x52=count;
  send(&e,target);previous=active;
 }
 if(previous)return 2;
 usleep(200000);printf("sent %d UIKit contact frames\n",steps);return 0;
}
