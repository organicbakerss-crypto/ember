import type { SeriesSummary, VolumeSummary } from '@shared/ipc'
import { VolumeView } from './VolumeView'

/** The writing view: a slim top bar for navigation, then the binder and the page. */
export function WritingView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  backLabel: string
  onBack: () => void
  onOpenSeries: () => void
}) {
  return (
    <div className="writing-view">
      <header className="top-bar">
        <button className="link" onClick={props.onBack}>
          ← {props.backLabel}
        </button>
        <nav className="breadcrumb small">
          <button className="link" onClick={props.onOpenSeries}>
            {props.series.name}
          </button>
          <span className="muted">/</span>
          <span>{props.volume.name}</span>
        </nav>
      </header>
      <VolumeView key={props.volume.id} seriesId={props.series.id} volume={props.volume} />
    </div>
  )
}
