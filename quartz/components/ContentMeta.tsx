import { Date, getDate, formatDate } from "./Date"
import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import readingTime from "reading-time"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"
import { JSX } from "preact"
import style from "./styles/contentMeta.scss"

interface ContentMetaOptions {
  /**
   * Whether to display reading time
   */
  showReadingTime: boolean
  /**
   * Whether to display created date
   */
  showCreatedDate: boolean
  /**
   * Whether to display modified date
   */
  showModifiedDate: boolean
  showComma: boolean
}

const defaultOptions: ContentMetaOptions = {
  showReadingTime: true,
  showCreatedDate: true,
  showModifiedDate: true,
  showComma: true,
}

export default ((opts?: Partial<ContentMetaOptions>) => {
  // Merge options with defaults
  const options: ContentMetaOptions = { ...defaultOptions, ...opts }

  function ContentMetadata({ cfg, fileData, displayClass }: QuartzComponentProps) {
    const text = fileData.text

    if (text) {
      const segments: (string | JSX.Element)[] = []

      if (fileData.dates) {
        // Display created date if enabled
        if (options.showCreatedDate && fileData.dates.created) {
          segments.push(
            <span>
              Created at{" "}
              <time datetime={fileData.dates.created.toISOString()}>
                {formatDate(fileData.dates.created, cfg.locale)}
              </time>
            </span>
          )
        }

        // Display modified date if enabled
        if (options.showModifiedDate && fileData.dates.modified) {
          segments.push(
            <span>
              Updated at{" "}
              <time datetime={fileData.dates.modified.toISOString()}>
                {formatDate(fileData.dates.modified, cfg.locale)}
              </time>
            </span>
          )
        }
      }

      // Display reading time if enabled
      if (options.showReadingTime) {
        const { minutes, words: _words } = readingTime(text)
        const displayedTime = i18n(cfg.locale).components.contentMeta.readingTime({
          minutes: Math.ceil(minutes),
        })
        segments.push(<span>{displayedTime}</span>)
      }

      return (
        <p show-comma={options.showComma} class={classNames(displayClass, "content-meta")}>
          {segments}
        </p>
      )
    } else {
      return null
    }
  }

  ContentMetadata.css = style

  return ContentMetadata
}) satisfies QuartzComponentConstructor
