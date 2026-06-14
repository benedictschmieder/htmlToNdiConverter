/*
 * ndi_sender.cc
 *
 * A minimal Node.js (N-API) native addon that wraps the NewTek/NDI(tm) SDK
 * sender API. It receives raw BGRA frame buffers from the Electron renderer
 * and transmits them on the network as an NDI video source.
 *
 * Frames are double-buffered: NDIlib_send_send_video_async_v2() keeps a
 * pointer to the submitted buffer until the *next* async send, so we alternate
 * between two internally owned buffers to guarantee the in-flight frame is
 * never overwritten while it is still being transmitted.
 */

#include <napi.h>
#include <Processing.NDI.Lib.h>

#include <vector>
#include <cstring>
#include <string>

class NdiSender : public Napi::ObjectWrap<NdiSender> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit NdiSender(const Napi::CallbackInfo& info);
  ~NdiSender();

 private:
  Napi::Value Send(const Napi::CallbackInfo& info);
  void Destroy(const Napi::CallbackInfo& info);
  void CleanUp();

  NDIlib_send_instance_t send_instance_ = nullptr;
  std::vector<uint8_t> buffers_[2];
  int buf_index_ = 0;
};

Napi::Object NdiSender::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "NdiSender", {
      InstanceMethod("send", &NdiSender::Send),
      InstanceMethod("destroy", &NdiSender::Destroy),
  });

  // Keep a persistent reference to the constructor.
  auto* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);
  env.SetInstanceData(constructor);

  exports.Set("NdiSender", func);
  return exports;
}

NdiSender::NdiSender(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NdiSender>(info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    throw Napi::TypeError::New(env, "NdiSender requires a source name string");
  }

  std::string source_name = info[0].As<Napi::String>().Utf8Value();

  if (!NDIlib_initialize()) {
    throw Napi::Error::New(
        env, "NDIlib_initialize() failed. Is the NDI runtime installed and is "
             "the CPU supported?");
  }

  NDIlib_send_create_t create_desc;
  create_desc.p_ndi_name = source_name.c_str();
  create_desc.p_groups = nullptr;
  create_desc.clock_video = false;  // Electron's frame rate drives timing.
  create_desc.clock_audio = false;

  send_instance_ = NDIlib_send_create(&create_desc);
  if (!send_instance_) {
    throw Napi::Error::New(env, "NDIlib_send_create() failed");
  }
}

NdiSender::~NdiSender() { CleanUp(); }

void NdiSender::CleanUp() {
  if (send_instance_) {
    // Flush any in-flight async frame before destroying.
    NDIlib_send_send_video_async_v2(send_instance_, nullptr);
    NDIlib_send_destroy(send_instance_);
    send_instance_ = nullptr;
  }
}

Napi::Value NdiSender::Send(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!send_instance_) {
    throw Napi::Error::New(env, "send() called on a destroyed NdiSender");
  }

  if (info.Length() < 5 || !info[0].IsBuffer() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
    throw Napi::TypeError::New(
        env, "send(buffer, width, height, frameRateN, frameRateD) expected");
  }

  Napi::Buffer<uint8_t> incoming = info[0].As<Napi::Buffer<uint8_t>>();
  const int width = info[1].As<Napi::Number>().Int32Value();
  const int height = info[2].As<Napi::Number>().Int32Value();
  const int frame_rate_n = info[3].As<Napi::Number>().Int32Value();
  const int frame_rate_d = info[4].As<Napi::Number>().Int32Value();

  if (width <= 0 || height <= 0) {
    throw Napi::RangeError::New(env, "width and height must be positive");
  }

  const size_t expected = static_cast<size_t>(width) * height * 4;
  if (incoming.Length() < expected) {
    throw Napi::RangeError::New(
        env, "buffer is smaller than width * height * 4 (BGRA)");
  }

  // Copy into the next internal buffer (double buffering for async send).
  std::vector<uint8_t>& dst = buffers_[buf_index_];
  if (dst.size() != expected) {
    dst.resize(expected);
  }
  std::memcpy(dst.data(), incoming.Data(), expected);

  NDIlib_video_frame_v2_t frame;
  frame.xres = width;
  frame.yres = height;
  frame.FourCC = NDIlib_FourCC_type_BGRA;
  frame.frame_rate_N = frame_rate_n > 0 ? frame_rate_n : 60000;
  frame.frame_rate_D = frame_rate_d > 0 ? frame_rate_d : 1000;
  frame.picture_aspect_ratio = static_cast<float>(width) / static_cast<float>(height);
  frame.frame_format_type = NDIlib_frame_format_type_progressive;
  frame.timecode = NDIlib_send_timecode_synthesize;
  frame.p_data = dst.data();
  frame.line_stride_in_bytes = width * 4;
  frame.p_metadata = nullptr;
  frame.timestamp = 0;

  NDIlib_send_send_video_async_v2(send_instance_, &frame);

  // Flip buffers so the in-flight frame is not overwritten next time.
  buf_index_ ^= 1;

  return env.Undefined();
}

void NdiSender::Destroy(const Napi::CallbackInfo& info) { CleanUp(); }

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return NdiSender::Init(env, exports);
}

NODE_API_MODULE(ndi_sender, InitAll)

