// ndi-probe.cc
//
// Standalone NDI receiver used to diagnose what a sender actually puts on the
// wire. It discovers sources, connects to the one whose name contains the
// substring passed as argv[1] (default: first source found), receives video
// for a few seconds and reports:
//   - delivered FourCC (BGRA vs BGRX => alpha present or not)
//   - resolution, declared frame rate, aspect ratio, frame format type
//   - measured received FPS
//   - dropped vs total frames (NDIlib_recv_get_performance)
//   - alpha min/max sampled across the frame (alpha hypothesis check)
//   - timecode / timestamp deltas (pacing / backlog check)
//
// Build (macOS):
//   clang++ -std=c++17 -I "NDI 6 SDK/Include" tools/ndi-probe.cc \
//       -o tools/ndi-probe /usr/local/lib/libndi.dylib
//
// Run:
//   ./tools/ndi-probe "MP-Timer"        # match by name substring
//   ./tools/ndi-probe                   # just use the first source

#include <cstddef>

#include <Processing.NDI.Lib.h>
#include <zlib.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

using clock_type = std::chrono::steady_clock;

static double now_seconds() {
  return std::chrono::duration<double>(clock_type::now().time_since_epoch())
      .count();
}

static std::string fourcc_to_string(int fourcc) {
  char c[5];
  c[0] = static_cast<char>((fourcc >> 0) & 0xFF);
  c[1] = static_cast<char>((fourcc >> 8) & 0xFF);
  c[2] = static_cast<char>((fourcc >> 16) & 0xFF);
  c[3] = static_cast<char>((fourcc >> 24) & 0xFF);
  c[4] = '\0';
  for (int i = 0; i < 4; i++) {
    if (c[i] < 32 || c[i] > 126) c[i] = '?';
  }
  return std::string(c) + " (0x" + std::to_string(fourcc) + ")";
}

static const char* frame_format_to_string(NDIlib_frame_format_type_e t) {
  switch (t) {
    case NDIlib_frame_format_type_progressive:
      return "progressive";
    case NDIlib_frame_format_type_interleaved:
      return "interleaved";
    case NDIlib_frame_format_type_field_0:
      return "field_0";
    case NDIlib_frame_format_type_field_1:
      return "field_1";
    default:
      return "unknown";
  }
}

// Returns true if the FourCC is a 4-byte-per-pixel packed format with an alpha
// byte we can sample (BGRA / RGBA).
static bool has_alpha_byte(int fourcc) {
  return fourcc == NDIlib_FourCC_type_BGRA || fourcc == NDIlib_FourCC_type_RGBA;
}

// Minimal PNG writer (8-bit RGB) so we can visually inspect a received frame.
static bool write_png(const char* path, const uint8_t* rgb, int w, int h) {
  std::vector<uint8_t> raw;
  raw.reserve((size_t)h * (1 + (size_t)w * 3));
  for (int y = 0; y < h; y++) {
    raw.push_back(0);  // filter type 0 (none) per scanline
    const uint8_t* row = rgb + (size_t)y * w * 3;
    raw.insert(raw.end(), row, row + (size_t)w * 3);
  }
  uLongf clen = compressBound(raw.size());
  std::vector<uint8_t> comp(clen);
  if (compress2(comp.data(), &clen, raw.data(), raw.size(), 6) != Z_OK)
    return false;
  comp.resize(clen);

  FILE* f = fopen(path, "wb");
  if (!f) return false;
  auto be32 = [&](uint32_t v) {
    uint8_t b[4] = {(uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8),
                    (uint8_t)v};
    fwrite(b, 1, 4, f);
  };
  auto chunk = [&](const char* type, const uint8_t* data, uint32_t len) {
    be32(len);
    uint32_t crc = crc32(0, (const Bytef*)type, 4);
    if (len) crc = crc32(crc, data, len);
    fwrite(type, 1, 4, f);
    if (len) fwrite(data, 1, len, f);
    be32(crc);
  };
  const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  fwrite(sig, 1, 8, f);
  uint8_t ihdr[13];
  auto p32 = [](uint8_t* o, uint32_t v) {
    o[0] = v >> 24; o[1] = v >> 16; o[2] = v >> 8; o[3] = v;
  };
  p32(ihdr, w);
  p32(ihdr + 4, h);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  chunk("IHDR", ihdr, 13);
  chunk("IDAT", comp.data(), (uint32_t)comp.size());
  chunk("IEND", nullptr, 0);
  fclose(f);
  return true;
}

// Convert a received BGRA/RGBA frame to a packed RGB buffer and save as PNG.
static void dump_frame_png(const NDIlib_video_frame_v2_t& v, const char* path) {
  if (!v.p_data || v.line_stride_in_bytes <= 0) return;
  const bool is_bgra = (v.FourCC == NDIlib_FourCC_type_BGRA);
  std::vector<uint8_t> rgb((size_t)v.xres * v.yres * 3);
  for (int y = 0; y < v.yres; y++) {
    const uint8_t* row = v.p_data + (size_t)y * v.line_stride_in_bytes;
    uint8_t* out = rgb.data() + (size_t)y * v.xres * 3;
    for (int x = 0; x < v.xres; x++) {
      const uint8_t* px = row + (size_t)x * 4;
      uint8_t b = is_bgra ? px[0] : px[2];
      uint8_t g = px[1];
      uint8_t r = is_bgra ? px[2] : px[0];
      out[x * 3 + 0] = r;
      out[x * 3 + 1] = g;
      out[x * 3 + 2] = b;
    }
  }
  if (write_png(path, rgb.data(), v.xres, v.yres))
    printf("[dump] wrote %s (%dx%d)\n", path, v.xres, v.yres);
  else
    printf("[dump] FAILED to write %s\n", path);
}

int main(int argc, char** argv) {
  const std::string wanted = (argc > 1) ? argv[1] : "";
  const double run_seconds = (argc > 2) ? atof(argv[2]) : 12.0;

  if (!NDIlib_initialize()) {
    fprintf(stderr, "NDIlib_initialize() failed (unsupported CPU?)\n");
    return 1;
  }

  // Direct-connect mode: skip discovery and connect straight to an ip:port.
  //   NDI_CONNECT_URL="10.80.96.71:5961" ./tools/ndi-probe
  const char* connect_url = getenv("NDI_CONNECT_URL");
  NDIlib_find_instance_t finder = nullptr;
  NDIlib_source_t source_to_use;
  source_to_use.p_ndi_name = "";
  source_to_use.p_url_address = nullptr;

  if (connect_url && *connect_url) {
    printf("[probe] DIRECT connect to %s (skipping discovery)\n", connect_url);
    source_to_use.p_ndi_name = "";
    source_to_use.p_url_address = connect_url;
  } else {
    NDIlib_find_create_t find_desc;
    find_desc.show_local_sources = true;
    find_desc.p_groups = nullptr;
    // Probe across subnets / when mDNS does not reach this host:
    //   NDI_EXTRA_IPS="10.80.10.5,10.80.10.6" ./tools/ndi-probe "MP-Timer"
    const char* extra_ips = getenv("NDI_EXTRA_IPS");
    find_desc.p_extra_ips = (extra_ips && *extra_ips) ? extra_ips : nullptr;
    if (find_desc.p_extra_ips) {
      printf("[probe] using extra IPs for discovery: %s\n",
             find_desc.p_extra_ips);
    }

    finder = NDIlib_find_create_v2(&find_desc);
    if (!finder) {
      fprintf(stderr, "NDIlib_find_create_v2() failed\n");
      return 1;
    }

    printf("[probe] discovering sources (up to 5s)...\n");
    const NDIlib_source_t* sources = nullptr;
    uint32_t count = 0;
    const double deadline = now_seconds() + 5.0;
    while (now_seconds() < deadline) {
      NDIlib_find_wait_for_sources(finder, 1000);
      sources = NDIlib_find_get_current_sources(finder, &count);
      if (count > 0) break;
    }

    if (count == 0) {
      fprintf(stderr, "[probe] no NDI sources found on the network.\n");
      NDIlib_find_destroy(finder);
      return 2;
    }

    printf("[probe] found %u source(s):\n", count);
    int chosen = -1;
    for (uint32_t i = 0; i < count; i++) {
      const char* name =
          sources[i].p_ndi_name ? sources[i].p_ndi_name : "(null)";
      const char* url =
          sources[i].p_url_address ? sources[i].p_url_address : "";
      printf("    [%u] %s   %s\n", i, name, url);
      if (chosen < 0 && (wanted.empty() ||
                         std::string(name).find(wanted) != std::string::npos)) {
        chosen = static_cast<int>(i);
      }
    }
    if (chosen < 0) {
      fprintf(stderr, "[probe] no source matched \"%s\".\n", wanted.c_str());
      NDIlib_find_destroy(finder);
      return 2;
    }
    printf("[probe] connecting to [%d] %s\n", chosen,
           sources[chosen].p_ndi_name);
    source_to_use = sources[chosen];
  }

  NDIlib_recv_create_v3_t recv_desc;
  recv_desc.source_to_connect_to = source_to_use;
  // BGRX_BGRA: receiver delivers BGRA when the source declares alpha, BGRX
  // when it does not -> directly reveals whether the sender advertises alpha.
  recv_desc.color_format = NDIlib_recv_color_format_BGRX_BGRA;
  recv_desc.bandwidth = NDIlib_recv_bandwidth_highest;
  recv_desc.allow_video_fields = false;
  recv_desc.p_ndi_recv_name = "html2ndi-probe";

  NDIlib_recv_instance_t recv = NDIlib_recv_create_v3(&recv_desc);
  if (!recv) {
    fprintf(stderr, "NDIlib_recv_create_v3() failed\n");
    if (finder) NDIlib_find_destroy(finder);
    return 1;
  }
  // Finder can be released once the receiver has been created.
  if (finder) NDIlib_find_destroy(finder);

  const double start = now_seconds();
  double window_start = start;
  int window_frames = 0;
  long long total_frames = 0;
  bool first = true;
  int64_t prev_timecode = 0;
  int64_t prev_timestamp = 0;

  printf("[probe] receiving for %.0fs...\n", run_seconds);
  while (now_seconds() - start < run_seconds) {
    NDIlib_video_frame_v2_t video;
    NDIlib_frame_type_e type =
        NDIlib_recv_capture_v2(recv, &video, nullptr, nullptr, 1000);

    if (type == NDIlib_frame_type_video) {
      total_frames++;
      window_frames++;

      if (first) {
        first = false;
        printf("\n[probe] FIRST VIDEO FRAME\n");
        printf("    FourCC          : %s\n",
               fourcc_to_string(video.FourCC).c_str());
        printf("    resolution      : %dx%d\n", video.xres, video.yres);
        printf("    declared rate   : %d/%d (%.3f fps)\n", video.frame_rate_N,
               video.frame_rate_D,
               video.frame_rate_D
                   ? (double)video.frame_rate_N / video.frame_rate_D
                   : 0.0);
        printf("    aspect ratio    : %.4f\n", video.picture_aspect_ratio);
        printf("    format type     : %s\n",
               frame_format_to_string(video.frame_format_type));
        printf("    line stride     : %d bytes\n",
               video.line_stride_in_bytes);
        const char* alpha_note =
            (video.FourCC == NDIlib_FourCC_type_BGRA)
                ? "BGRA => source DECLARES ALPHA (compositing/old-stream risk)"
                : (video.FourCC == NDIlib_FourCC_type_BGRX)
                      ? "BGRX => no alpha (opaque)"
                      : "non-RGB format";
        printf("    ALPHA VERDICT   : %s\n", alpha_note);
        printf("\n");
        dump_frame_png(video, "tools/frame_first.png");
      }

      // Dump a later frame too (catches content that changes over time).
      if (total_frames == 120) {
        dump_frame_png(video, "tools/frame_later.png");
      }

      // Inspect actual pixel CONTENT for BGRA/RGBA frames: per-channel min/max
      // and mean. This reveals whether the sender is pushing real content or
      // just a uniform (e.g. all-black or all-white) frame at full frame rate.
      if (has_alpha_byte(video.FourCC) && video.p_data &&
          video.line_stride_in_bytes > 0) {
        const bool is_bgra = (video.FourCC == NDIlib_FourCC_type_BGRA);
        uint8_t amin = 255, amax = 0;
        uint8_t rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
        double rsum = 0, gsum = 0, bsum = 0;
        long samples = 0;
        const int step_x = video.xres > 32 ? video.xres / 32 : 1;
        const int step_y = video.yres > 32 ? video.yres / 32 : 1;
        for (int y = 0; y < video.yres; y += step_y) {
          const uint8_t* row =
              video.p_data + (size_t)y * video.line_stride_in_bytes;
          for (int x = 0; x < video.xres; x += step_x) {
            const uint8_t* px = row + (size_t)x * 4;
            // Byte order: BGRA => [B,G,R,A]; RGBA => [R,G,B,A].
            uint8_t b = is_bgra ? px[0] : px[2];
            uint8_t g = px[1];
            uint8_t r = is_bgra ? px[2] : px[0];
            uint8_t a = px[3];
            if (a < amin) amin = a;
            if (a > amax) amax = a;
            if (r < rmin) rmin = r;
            if (r > rmax) rmax = r;
            if (g < gmin) gmin = g;
            if (g > gmax) gmax = g;
            if (b < bmin) bmin = b;
            if (b > bmax) bmax = b;
            rsum += r;
            gsum += g;
            bsum += b;
            samples++;
          }
        }
        if (total_frames % 30 == 1 && samples > 0) {
          const bool uniform = (rmin == rmax && gmin == gmax && bmin == bmax);
          printf(
              "[content] R[%u-%u avg%.0f] G[%u-%u avg%.0f] B[%u-%u avg%.0f] "
              "A[%u-%u] %s\n",
              rmin, rmax, rsum / samples, gmin, gmax, gsum / samples, bmin, bmax,
              bsum / samples, amin, amax,
              uniform ? (rmax == 0 ? "*** UNIFORM BLACK ***"
                                   : "*** UNIFORM (single color) ***")
                      : "has variation (real content)");
        }
      }

      // Timecode / timestamp deltas (100ns units) on the first few frames.
      if (total_frames <= 6) {
        printf("[ts] frame=%lld timecode=%lld (d=%lld) timestamp=%lld (d=%lld)\n",
               total_frames, (long long)video.timecode,
               (long long)(video.timecode - prev_timecode),
               (long long)video.timestamp,
               (long long)(video.timestamp - prev_timestamp));
        prev_timecode = video.timecode;
        prev_timestamp = video.timestamp;
      }

      NDIlib_recv_free_video_v2(recv, &video);
    } else if (type == NDIlib_frame_type_none) {
      printf("[probe] no frame for 1s (sender stalled or not sending)\n");
    }

    // Once per second: measured fps + dropped-frame performance.
    double t = now_seconds();
    if (t - window_start >= 1.0) {
      NDIlib_recv_performance_t total_perf, dropped_perf;
      NDIlib_recv_get_performance(recv, &total_perf, &dropped_perf);
      printf("[rate] received=%.1f fps  total=%lld dropped=%lld  conns=%d\n",
             window_frames / (t - window_start),
             (long long)total_perf.video_frames,
             (long long)dropped_perf.video_frames,
             NDIlib_recv_get_no_connections(recv));
      window_frames = 0;
      window_start = t;
    }
  }

  printf("\n[probe] done. total video frames received: %lld\n", total_frames);
  NDIlib_recv_destroy(recv);
  NDIlib_destroy();
  return 0;
}
