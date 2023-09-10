interface LogProps {
  entries: string[]
}

const Log = ({ entries }: LogProps): JSX.Element => {
  const formatedLog = entries.map((entry, index) => <span key={index}>{entry}</span>)
  return <div className="log">{formatedLog.reverse()}</div>
}

export default Log
