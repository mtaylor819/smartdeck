// host_io.h -- [net] makes the sketch's `Serial` also talk to the authenticated WiFi host link.
// OWNER: fork "net". Included ONCE from smart_deck.ino, after the core includes and BEFORE the first use of Serial.
//
// How it works: HostIOClass wraps the real USB/UART Serial. After this header, the preprocessor maps the sketch's
// `Serial` to a HostIOClass instance, so every existing Serial.print*/printf/write/read call keeps working:
//   * OUTPUT : always written to the real Serial (USB bytes are byte-for-byte what they were), and teed (buffered,
//              flushed per line, NON-blocking send) to the authenticated TCP client if one is connected.
//   * INPUT  : read from the real Serial by default. While a command that ARRIVED over TCP is being handled
//              (useTcpInput(true)), reads (e.g. the START_UPLOAD file transfer) come from the TCP client instead.
// Libraries are compiled separately and still see the real `Serial`.
#ifndef HOST_IO_H
#define HOST_IO_H

#include <WiFi.h>
#include <WiFiClient.h>
#include <lwip/sockets.h>
#include <errno.h>

class HostIOClass : public Stream {
 public:
  using Print::write;

  // --- USB lifecycle passthrough ---
  void begin(unsigned long baud) { usb_.begin(baud); }
  void end() { usb_.end(); }
  operator bool() const { return (bool)usb_; }

  // --- TCP link wiring (called by net_wifi.h) ---
  void setTcp(WiFiClient* c) {
    flushTcp();
    tcp_ = c;
    olen_ = 0;
    in_ = &usb_;
  }
  bool hasTcp() const { return tcp_ != nullptr; }
  void useTcpInput(bool on) { in_ = (on && tcp_) ? static_cast<Stream*>(tcp_) : static_cast<Stream*>(&usb_); }

  // Push any buffered output to the TCP client without blocking the main loop (a full socket drops data).
  void flushTcp() {
    if (!tcp_ || olen_ == 0) { olen_ = 0; return; }
    int fd = tcp_->fd();
    if (fd < 0) { olen_ = 0; return; }
    size_t off = 0;
    int retries = 0;
    while (off < olen_ && retries < 5) {
      int n = ::send(fd, obuf_ + off, olen_ - off, MSG_DONTWAIT);
      if (n > 0) { off += (size_t)n; continue; }
      if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { retries++; delay(1); continue; }
      break;  // error / closed: drop (the link tick notices the dead socket)
    }
    olen_ = 0;
  }

  // --- Stream interface ---
  int available() override { return in_->available(); }
  int read() override { return in_->read(); }
  int peek() override { return in_->peek(); }
  void flush() override { usb_.flush(); flushTcp(); }
  size_t readBytes(char* buffer, size_t length) override {
    in_->setTimeout(getTimeout());
    return in_->readBytes(buffer, length);
  }
  size_t readBytes(uint8_t* buffer, size_t length) override { return readBytes((char*)buffer, length); }

  size_t write(uint8_t c) override {
    size_t w = usb_.write(c);
    tee(&c, 1);
    return w;
  }
  size_t write(const uint8_t* buffer, size_t size) override {
    size_t w = usb_.write(buffer, size);
    tee(buffer, size);
    return w;
  }
  int availableForWrite() { return usb_.availableForWrite(); }

 private:
  void tee(const uint8_t* b, size_t n) {
    if (!tcp_) return;
    for (size_t i = 0; i < n; i++) {
      obuf_[olen_++] = b[i];
      if (b[i] == '\n' || olen_ >= sizeof(obuf_)) flushTcp();
    }
  }

  decltype(Serial)& usb_ = Serial;  // the REAL serial port (the macro below is defined after this class)
  WiFiClient* tcp_ = nullptr;
  Stream* in_ = &usb_;
  uint8_t obuf_[512];
  size_t olen_ = 0;
};

static HostIOClass HostIOStream;
#define Serial HostIOStream

#endif
