use std::io::{Read,Write};
use std::net::{TcpListener,TcpStream};
use std::time::{Duration,Instant};
fn main(){
 let listener=TcpListener::bind("127.0.0.1:0").unwrap();let addr=listener.local_addr().unwrap();listener.set_nonblocking(true).unwrap();
 let send=std::thread::spawn(move||{let mut socket=TcpStream::connect(addr).unwrap();std::thread::sleep(Duration::from_millis(100));socket.write_all(b"x").unwrap();});
 let (mut socket,_)=loop {match listener.accept(){Ok(pair)=>break pair,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(1)),Err(e)=>panic!("{e}")}};
 socket.set_read_timeout(Some(Duration::from_secs(1))).unwrap();let started=Instant::now();let mut buf=[0u8;1];let result=socket.read(&mut buf);
 println!("accepted_stream_first_read={:?}, elapsed_ms={}",result.as_ref().map(|n|*n).map_err(|e|e.kind()),started.elapsed().as_millis());
 socket.set_nonblocking(false).unwrap();if result.is_err(){println!("explicit_blocking_read={:?}",socket.read(&mut buf).as_ref().map(|n|*n).map_err(|e|e.kind()));}send.join().unwrap();
}
