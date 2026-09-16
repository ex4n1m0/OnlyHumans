//! Print the global room id derived from THIS build's global key.
//! Ops tool: compare across builds/clones — same hex = same room.
use onlyhumans_core::rooms::global_room_hex;

fn main() {
    println!("{}", global_room_hex(&onlyhumans_core::global_key()));
}
