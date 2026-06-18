interface FilenameProps {
  name: string
  truncate?: boolean
  className?: string
}

export const Filename = ({ name, truncate = false, className }: FilenameProps) => {
  if (truncate) {
    return (
      <span
        className={`filename-truncate ${className ?? ''}`}
        title={name}
      >
        {name}
      </span>
    )
  }
  return (
    <span className={`filename ${className ?? ''}`}>
      {name}
    </span>
  )
}
