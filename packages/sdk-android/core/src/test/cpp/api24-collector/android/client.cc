// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#include "handoff.h"
#include <android/api-level.h>
#include <android/log.h>
#include <jni.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>
#include "client/crashpad_client.h"
#include "client/crashpad_info.h"
#include "client/simple_string_dictionary.h"
#include "util/linux/socket.h"
#include "util/posix/spawn_subprocess.h"
namespace qa=everframe_qualification::android;
namespace {
struct Session {int control;pid_t handler;std::array<uint8_t,16> challenge;};
Session* session=nullptr;
bool Random(void* bytes,size_t size){int fd=open("/dev/urandom",O_RDONLY|O_CLOEXEC);if(fd<0)return false;auto* p=static_cast<uint8_t*>(bytes);size_t n=0;while(n<size){ssize_t r=read(fd,p+n,size-n);if(r<0&&errno==EINTR)continue;if(r<=0){close(fd);return false;}n+=r;}close(fd);return true;}
std::string String(JNIEnv* env,jstring s){const char* p=env->GetStringUTFChars(s,nullptr);std::string value=p?p:"";if(p)env->ReleaseStringUTFChars(s,p);return value;}
jstring Status(JNIEnv* env,const char* value){__android_log_print(ANDROID_LOG_INFO,"EVNativeQualification","EV_CLIENT %s client=%d uid=%d",value,getpid(),getuid());return env->NewStringUTF(value);}
extern "C" const char ev_android_fault_pc[];
[[noreturn]] __attribute__((noinline)) void Fault(){
  volatile char canary[]="EV_STACK_SECRET_QUALIFICATION";asm volatile(""::"r"(&canary):"memory");
#if defined(__aarch64__)
  asm volatile("mov x9, #0\n.global ev_android_fault_pc\nev_android_fault_pc:\nstr w9, [x9]\n":::"x9","memory");
#elif defined(__arm__)
  asm volatile("mov r3, #0\n.global ev_android_fault_pc\nev_android_fault_pc:\nstr r3, [r3]\n":::"r3","memory");
#elif defined(__x86_64__)
  asm volatile("xor %%rax, %%rax\n.global ev_android_fault_pc\nev_android_fault_pc:\nmovb $0, (%%rax)\n":::"rax","memory");
#elif defined(__i386__)
  asm volatile("xor %%eax, %%eax\n.global ev_android_fault_pc\nev_android_fault_pc:\nmovb $0, (%%eax)\n":::"eax","memory");
#endif
  _exit(90);
}
}
extern "C" JNIEXPORT jstring JNICALL Java_dev_everframe_qualification_MainActivity_nativeStatus(JNIEnv* env,jclass){return Status(env,"off; no handler installed");}
static jstring Arm(JNIEnv* env,jstring directory_value,jstring library_value,jint failure_mode,jbyteArray provided_key,jstring provided_epoch){
  if(session)return Status(env,"already armed");
  const auto directory=String(env,directory_value),library=String(env,library_value);
  crashpad::ScopedFileHandle crash_client,crash_handler,control_client,control_handler;
  if(!crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&crash_client,&crash_handler)||!crashpad::UnixCredentialSocket::CreateCredentialSocketpair(&control_client,&control_handler))return Status(env,"socket failure; unarmed");
  int sentinel=open("/dev/null",O_RDONLY);if(sentinel<0)return Status(env,"sentinel failure; unarmed");
  std::vector<std::string> args={"--control-fd="+std::to_string(control_handler.get()),"--expected-client="+std::to_string(getpid()),"--qualification-directory="+directory};
  if(failure_mode==3)args.push_back("--qualification-fail-server-init");
  if(failure_mode==4)args.push_back("--qualification-fail-controller-start");
  std::set<int> preserve={control_handler.get()};if(failure_mode==2)preserve.insert(sentinel);bool spawned=false;
  const std::string trampoline=library+"/libeverframe_qualification_trampoline.so",handler=library+"/libeverframe_qualification_handler.so";
  if(android_get_device_api_level()>=29){spawned=crashpad::CrashpadClient::StartHandlerWithLinkerForClient(trampoline,handler,sizeof(void*)==8,nullptr,{}, {},"",{},args,crash_handler.get(),preserve);}
  else {std::vector<std::string> command={trampoline,handler};command.insert(command.end(),args.begin(),args.end());command.push_back("--initial-client-fd="+std::to_string(crash_handler.get()));preserve.insert(crash_handler.get());spawned=crashpad::SpawnSubprocess(command,nullptr,preserve,false,nullptr);}
  close(sentinel);crash_handler.reset();control_handler.reset();if(!spawned)return Status(env,"spawn failure; unarmed");
  qa::Frame frame{};frame.kind=qa::kProvision;frame.pid=getpid();frame.expected_pc=reinterpret_cast<uintptr_t>(ev_android_fault_pc);std::array<uint8_t,16> epoch{};
  if(!Random(frame.key.data(),frame.key.size())||!Random(frame.challenge.data(),frame.challenge.size())||!Random(epoch.data(),epoch.size())){qa::Clear(&frame,sizeof frame);qa::Clear(epoch.data(),epoch.size());return Status(env,"random failure; unarmed");}
  const char* hex="0123456789abcdef";for(size_t i=0;i<epoch.size();i++){frame.epoch[i*2]=hex[epoch[i]>>4];frame.epoch[i*2+1]=hex[epoch[i]&15];}qa::Clear(epoch.data(),epoch.size());
  if(provided_key || provided_epoch){
    const auto frozen_epoch=provided_epoch?String(env,provided_epoch):"";
    if(!provided_key||env->GetArrayLength(provided_key)!=32||frozen_epoch.size()!=32||!std::all_of(frozen_epoch.begin(),frozen_epoch.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');})){qa::Clear(&frame,sizeof frame);return Status(env,"frozen provision rejected; unarmed");}
    env->GetByteArrayRegion(provided_key,0,32,reinterpret_cast<jbyte*>(frame.key.data()));
    if(env->ExceptionCheck()){qa::Clear(&frame,sizeof frame);return nullptr;}
    std::copy(frozen_epoch.begin(),frozen_epoch.end(),frame.epoch.begin());
  }
  if(!qa::KeyAbsentFromInputs(frame.key)){qa::Clear(&frame,sizeof frame);return Status(env,"private input check failed; unarmed");}
  auto challenge=frame.challenge;if(failure_mode==1)frame.version=2;
  bool sent=qa::Send(control_client.get(),frame);qa::Clear(&frame,sizeof frame);
  const bool cleared=std::all_of(reinterpret_cast<uint8_t*>(&frame),reinterpret_cast<uint8_t*>(&frame)+sizeof frame,[](uint8_t b){return b==0;});
  qa::Frame ready{};qa::Peer peer{};
  if(!sent||!cleared||!qa::Receive(control_client.get(),&ready,&peer)||peer.pid==getpid()||!qa::Ready(ready,challenge,peer.pid,peer.uid,getuid()))return Status(env,"readiness rejected; unarmed; key buffers cleared");
  auto* annotations=new crashpad::SimpleStringDictionary;annotations->SetKeyValue("qualification-private","EV_ANNOTATION_SECRET_QUALIFICATION");crashpad::CrashpadInfo::GetCrashpadInfo()->set_simple_annotations(annotations);
  crashpad::CrashpadClient client;if(!client.SetHandlerSocket(std::move(crash_client),peer.pid))return Status(env,"installation failed; key buffers cleared");
  session=new Session{control_client.release(),peer.pid,challenge};
  return Status(env,"ready; peer verified; key_not_args_env=1; key buffers cleared; handler installed");
}
extern "C" JNIEXPORT jstring JNICALL Java_dev_everframe_qualification_MainActivity_nativeArm(JNIEnv* env,jclass,jstring directory,jstring libraries,jint mode){return Arm(env,directory,libraries,mode,nullptr,nullptr);}
extern "C" JNIEXPORT jstring JNICALL Java_dev_everframe_qualification_MainActivity_nativeArmFrozen(JNIEnv* env,jclass,jstring directory,jstring libraries,jbyteArray key,jstring epoch){return Arm(env,directory,libraries,0,key,epoch);}
extern "C" JNIEXPORT jstring JNICALL Java_dev_everframe_qualification_MainActivity_nativeRevoke(JNIEnv* env,jclass){
  if(!session)return Status(env,"unarmed");qa::Frame request{};request.kind=qa::kRevoke;request.pid=getpid();request.challenge=session->challenge;qa::Frame reply{};qa::Peer peer{};
  if(!qa::Send(session->control,request)||!qa::Receive(session->control,&reply,&peer)||!qa::Valid(reply,qa::kRevoked,session->handler,peer.uid,getuid())||peer.pid!=session->handler||reply.challenge!=session->challenge)return Status(env,"revoke failed");
  return Status(env,"revoke acknowledged; authority disabled");
}
extern "C" JNIEXPORT void JNICALL Java_dev_everframe_qualification_MainActivity_nativeFault(JNIEnv*,jclass,jboolean use_abort){if(use_abort)abort();Fault();}
