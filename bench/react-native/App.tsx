import React, { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

const ROWS = Array.from({ length: 40 }, (_, i) => `Stem ${i}`)
const pad = (n: number, w: number) => String(n).padStart(w, '0')

// Same screen as bench/fixture: the elapsed label and progress bar change on every frame, forever.
export default function App() {
  const [ms, setMs] = useState(0)
  const [taps, setTaps] = useState(0)
  useEffect(() => {
    const start = Date.now()
    let id = requestAnimationFrame(function frame() {
      setMs(Date.now() - start)
      id = requestAnimationFrame(frame)
    })
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <View style={styles.root}>
      <Text style={styles.elapsed}>{`${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`}</Text>
      <View style={styles.track}><View style={[styles.bar, { width: `${(ms % 10000) / 100}%` }]} /></View>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => setTaps(t => t + 1)}>
        <Text style={styles.label}>Mute Bass</Text>
      </Pressable>
      <Text>{`taps ${taps}`}</Text>
      <FlatList data={ROWS} keyExtractor={r => r} renderItem={({ item }) => <Text style={styles.row}>{item}</Text>} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingTop: 48, paddingHorizontal: 24, backgroundColor: '#fff' },
  elapsed: { fontSize: 32 },
  track: { alignSelf: 'stretch', height: 6, backgroundColor: '#ddd', marginVertical: 8 },
  bar: { height: 6, backgroundColor: '#3367d6' },
  button: { backgroundColor: '#3367d6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, margin: 8 },
  label: { color: '#fff' },
  row: { fontSize: 9 },
})
