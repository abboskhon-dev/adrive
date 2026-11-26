import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

void main() => runApp(const MaterialApp(title: 'adrive Flutter', home: Player()));

// Same screen as bench/fixture: the elapsed label and progress bar change on every frame, forever.
class Player extends StatefulWidget {
  const Player({super.key});
  @override
  State<Player> createState() => _PlayerState();
}

class _PlayerState extends State<Player> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker((d) => setState(() => _ms = d.inMilliseconds))..start();
  int _ms = 0;
  int _taps = 0;

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ms = _ms;
    final elapsed = '${ms ~/ 60000}:${(ms ~/ 1000 % 60).toString().padLeft(2, '0')}.${(ms % 1000).toString().padLeft(3, '0')}';
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.fromLTRB(24, 48, 24, 0),
        child: Column(children: [
          Text(elapsed, style: const TextStyle(fontSize: 32)),
          LinearProgressIndicator(value: ms % 10000 / 10000),
          ElevatedButton(onPressed: () => setState(() => _taps++), child: const Text('Mute Bass')),
          Text('taps $_taps'),
          Expanded(
            child: ListView.builder(
              itemCount: 40,
              itemBuilder: (_, i) => Text('Stem $i', style: const TextStyle(fontSize: 9)),
            ),
          ),
        ]),
      ),
    );
  }
}
